/********************************************************************************
 * Copyright (C) 2019 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/**
 * This test suite assumes that we run in a NodeJS environment!
 */

import { spawn, execSync, SpawnOptions, ChildProcess, spawnSync } from 'child_process';
import { Readable } from 'stream';
import { join } from 'path';

import { TerminalProcessInfo } from '@theia/terminal/lib/common/base-terminal-protocol';

import { prepareCommandLine, CommandLineOptions } from './run-in-terminal';

import {
    bgRed, bgWhite, bgYellow,
    black, green, magenta, red, white, yellow,
    bold,
} from 'colors/safe'; // tslint:disable-line:no-implicit-dependencies

export interface TestProcessInfo extends TerminalProcessInfo {
    shell: ChildProcess
}

const isWindows = process.platform === 'win32';
const _debug = !!process.env['THEIA_TEST_DEBUG'];
// tslint:disable-next-line:no-any
function debug(...parts: any[]): void {
    if (_debug) {
        console.debug(...parts);
    }
}

const testResources = join(__dirname, '../../src/browser/tests');
const spawnOptions: SpawnOptions = {
    // We do our own quoting, don't rely on the one done by NodeJS:
    windowsVerbatimArguments: true,
    stdio: ['pipe', 'pipe', 'pipe'],
};

// Formatting options, used with `scanLines` for debugging.
const stdoutFormat = (prefix: string) => (data: string) =>
    `${bold(yellow(`${prefix} STDOUT:`))} ${bgYellow(black(data))}`;
const stderrFormat = (prefix: string) => (data: string) =>
    `${bold(red(`${prefix} STDERR:`))} ${bgRed(white(data))}`;

// Default error scanner
const errorScanner = (handle: ScanLineHandle<void>) => {
    if (
        /^\s*\w+Error:/.test(handle.line)
        || /^\s*Cannot find /.test(handle.line)
    ) {
        throw new Error(handle.text);
    }
};

// Yarn mangles the PATH and creates some proxy script around node(.exe),
// which messes up our environment, failing the tests.
const nodePath =
    process.env['npm_node_execpath'] ||
    process.env['NODE'];
if (!nodePath) {
    throw new Error('Could not determine the real node path.');
}

const shellConfigs = [{
    name: 'bash',
    path: execShellCommand(isWindows
        ? 'where bash'
        : 'command -v bash'),
}, {
    name: 'cmd',
    path: isWindows
        && 'cmd.exe'
        || undefined,
}, {
    name: 'powershell',
    path: execShellCommand(isWindows
        ? 'where powershell'
        : 'command -v pwsh'),
}];

// 18d/12m/19y - Ubuntu 16.04:
// Powershell sometimes fails when running as part of an npm lifecycle script.
// See following error:
//
// tslint:disable:max-line-length
//
//  FailFast:
//  The type initializer for 'Microsoft.PowerShell.ApplicationInsightsTelemetry' threw an exception.
//
//     at System.Environment.FailFast(System.String, System.Exception)
//     at System.Environment.FailFast(System.String, System.Exception)
//     at Microsoft.PowerShell.UnmanagedPSEntry.Start(System.String, System.String[], Int32)
//     at Microsoft.PowerShell.ManagedPSEntry.Main(System.String[])
//
//  Exception details:
//  System.TypeInitializationException: The type initializer for 'Microsoft.PowerShell.ApplicationInsightsTelemetry' threw an exception. ---> System.ArgumentException: Item has already been added. Key in dictionary: 'SPAWN_WRAP_SHIM_ROOT'  Key being added: 'SPAWN_WRAP_SHIM_ROOT'
//     at System.Collections.Hashtable.Insert(Object key, Object nvalue, Boolean add)
//     at System.Environment.ToHashtable(IEnumerable`1 pairs)
//     at System.Environment.GetEnvironmentVariables()
//     at Microsoft.ApplicationInsights.Extensibility.Implementation.Platform.PlatformImplementation..ctor()
//     at Microsoft.ApplicationInsights.Extensibility.Implementation.Platform.PlatformSingleton.get_Current()
//     at Microsoft.ApplicationInsights.Extensibility.Implementation.TelemetryConfigurationFactory.Initialize(TelemetryConfiguration configuration, TelemetryModules modules)
//     at Microsoft.ApplicationInsights.Extensibility.TelemetryConfiguration.get_Active()
//     at Microsoft.PowerShell.ApplicationInsightsTelemetry..cctor()
//     --- End of inner exception stack trace ---
//     at Microsoft.PowerShell.ApplicationInsightsTelemetry.SendPSCoreStartupTelemetry()
//     at Microsoft.PowerShell.ConsoleHost.Start(String bannerText, String helpText, String[] args)
//     at Microsoft.PowerShell.ConsoleShell.Start(String bannerText, String helpText, String[] args)
//     at Microsoft.PowerShell.UnmanagedPSEntry.Start(String consoleFilePath, String[] args, Int32 argc)
//
// tslint:enable:max-line-length

let id = 0;
for (const shellSetup of shellConfigs) {
    const testContextName = `${shellSetup.name}/${++id}`;

    // For each shell, skip if we could not find the executable path.
    if (!shellSetup.path) {
        console.warn(`skipping ${shellSetup.name}`);
        continue;
    }

    // Test if powershell is able to run...
    if (shellSetup.name === 'powershell') {
        const powershellTestRun = spawnSync(shellSetup.path);
        if (typeof powershellTestRun.signal === 'string' ||
            typeof powershellTestRun.status === 'number' &&
            powershellTestRun.status !== 0
        ) {
            debug(stdoutFormat(testContextName)(
                displayWhitespaces(powershellTestRun.stdout.toString())));
            debug(stderrFormat(testContextName)(
                displayWhitespaces(powershellTestRun.stderr.toString())));
            console.warn('skipping powershell, seems to error on start.');
            continue;
        }
    }

    describe(`test ${shellSetup.name} commands`, function (): void {
        this.timeout(10_000);

        // On windows, when running bash we need to convert paths from Windows
        // to their mounting point, assuming bash is running within WSL.
        const cwd = isWindows && shellSetup.name === 'bash'
            ? convertWindowsPath(testResources)
            : testResources;

        // When running powershell, it seems like good mesure to send `\n` twice...
        const submit = shellSetup.name === 'powershell'
            ? '\n\n' : undefined;

        let processInfo: TestProcessInfo;
        let context: TestCaseContext;

        beforeEach(() => {
            context = new TestCaseContext(testContextName, submit);
            processInfo = createShell(context, shellSetup.path!);
        });

        afterEach(() => {
            processInfo.shell.kill();
            context.finalize();
        });

        it('use simple environment variables', async () => {
            const envName = 'SIMPLE_NAME';
            const envValue = 'SIMPLE_VALUE';
            await testCommandLine(
                context, processInfo,
                {
                    cwd, args: [nodePath, '-p', `\`[\${process.env['${envName}']}]\``],
                    env: {
                        [envName]: envValue,
                    }
                }, [
                    // stderr
                    scanLines<void>(context, processInfo.shell.stderr, errorScanner, stderrFormat(context.name)),
                    // stdout
                    scanLines<void>(context, processInfo.shell.stdout, handle => {
                        errorScanner(handle);
                        if (handle.line.includes(`[${envValue}]`)) {
                            handle.resolve();
                        }
                    }, stdoutFormat(context.name)),
                ]);
        });

        it('use problematic environment variables', async () => {
            const envName = 'A?B_C | D $PATH';
            const envValue = 'SUCCESS';
            await testCommandLine(
                context, processInfo,
                {
                    cwd, args: [nodePath, '-p', `\`[\${process.env['${envName}']}]\``],
                    env: {
                        [envName]: envValue,
                    }
                }, [
                    // stderr
                    scanLines<void>(context, processInfo.shell.stderr, errorScanner, stderrFormat(context.name)),
                    // stdout
                    scanLines<void>(context, processInfo.shell.stdout, handle => {
                        errorScanner(handle);
                        if (handle.line.includes(`[${envValue}]`)) {
                            handle.resolve();
                        }
                        if (handle.line.includes('[undefined]')) {
                            handle.reject(new Error(handle.text));
                        }
                    }, stdoutFormat(context.name)),
                ]);
        });

        it('command with whitespaces', async () => {
            const left = 'ABC';
            const right = 'DEF';
            await testCommandLine(
                context, processInfo,
                {
                    cwd, args: [nodePath, '-e', `{
                        const left = '${left}';
                        const right = '${right}';
                        console.log(\`[\${left}|\${right}]\`);
                    }`],
                }, [
                    // stderr
                    scanLines<void>(context, processInfo.shell.stderr, errorScanner, stderrFormat(context.name)),
                    // stdout
                    scanLines<void>(context, processInfo.shell.stdout, handle => {
                        errorScanner(handle);
                        if (handle.line.includes(`[${left}|${right}]`)) {
                            handle.resolve();
                        }
                    }, stdoutFormat(context.name)),
                ]);
        });

    });

}

/**
 * Allow `command` to fail and return undefined instead.
 *
 * @param command
 */
function execShellCommand(command: string): string | undefined {
    try {
        return execSync(command).toString().trim();
    } catch (error) {
        console.error(command, error);
        return undefined;
    }
}

/**
 * When executing `bash.exe` on Windows, the `C:`, `D:`, etc drives are mounted under `/mnt/<drive>/...`
 */
function convertWindowsPath(windowsPath: string): string {
    return windowsPath
        // Convert back-slashes to forward-slashes
        .replace(/\\/g, '/')
        // Convert drive-letter to usual mounting point in WSL
        .replace(/^[A-Za-z]:\//, s => `/mnt/${s[0].toLowerCase()}/`);
}

/**
 * Display trailing whitespace in a string, such as \r and \n.
 */
function displayWhitespaces(line: string): string {
    return line
        .replace(/\r?\n$/, s => s.length === 2 ? '<\\r\\n>' : '<\\n>')
        .replace(/\n/g, '<\\n>\n')
        .replace(/\r/g, '<\\r>\r');
}

/**
 * Actually run `prepareCommandLine`.
 *
 * Quirk: We send `\n` twice, powershell doesn't seem to execute commands if we
 * send '\n' only once...
 */
async function testCommandLine(
    context: TestCaseContext,
    processInfo: TestProcessInfo,
    options: CommandLineOptions,
    // tslint:disable-next-line: no-any
    firstOf: Array<Promise<any>>,
    // tslint:disable-next-line: no-any
): Promise<any> {
    const commandLine = prepareCommandLine(processInfo, options);
    debug(`${bold(white(`${context.name} STDIN:`))} ${bgWhite(black(displayWhitespaces(commandLine)))}`);
    processInfo.shell.stdin.write(commandLine + context.submit);
    return Promise.race(firstOf);
}

/**
 * Creates a `(Test)ProcessInfo` object by spawning the specified shell.
 */
function createShell(
    context: TestCaseContext,
    shellExecutable: string,
    shellArguments: string[] = []
): TestProcessInfo {
    const shell = spawn(shellExecutable, shellArguments, spawnOptions);
    debug(magenta(`${bold(`${context.name} SPAWN:`)} ${shellExecutable} ${shellArguments.join(' ')}`));
    shell.on('close', (code, signal) => debug(magenta(
        `${bold(`${context.name} CLOSE:`)} ${shellExecutable} code(${code}) signal(${signal})`
    )));
    return {
        executable: shellExecutable,
        arguments: [],
        shell,
    };
}

/**
 * Fire `callback` once per new detected line.
 *
 * @param pty
 * @param callback
 */
async function scanLines<T = void>(
    context: TestCaseContext,
    stream: Readable,
    callback: (handle: ScanLineHandle<T>) => void,
    debugFormat = (s: string) => s,
): Promise<T> {
    return new Promise((resolve, reject) => {
        let line = '';
        let text = '';
        stream.on('close', () => {
            debug(debugFormat('<CLOSED>'));
        });
        // The `data` listener will be collected on 'close', which will happen
        // once we kill the process.
        stream.on('data', data => {
            if (context.resolved) {
                return;
            }
            const split = data.toString().split('\n');
            while (!context.resolved && split.length > 1) {
                line += split.shift()! + '\n';
                text += line;
                debug(debugFormat(displayWhitespaces(line)));
                try {
                    callback({
                        resolve: (value: T) => {
                            if (!context.resolved) {
                                context.resolve();
                                resolve(value);
                                debug(bold(green(`${context.name} SCANLINES RESOLVED`)));
                            }
                        },
                        reject: (reason?: Error) => {
                            if (!context.resolved) {
                                context.resolve();
                                reject(reason);
                                debug(bold(red(`${context.name} SCANLINES REJECTED`)));
                            }
                        },
                        line,
                        text,
                    });
                } catch (error) {
                    debug(bold(red(`${context.name} SCANLINES THROWED`)));
                    context.resolve();
                    reject(error);
                    break;
                }
                line = '';
            }
            line += split[0];
        });
    });

}
interface ScanLineHandle<T> {

    /**
     * Finish listening to new events with a return value.
     */
    resolve: (value: T) => void
    /**
     * Finish listening to new events with an error.
     */
    reject: (reason?: Error) => void
    /**
     * Currently parsed line.
     */
    line: string
    /**
     * The whole output buffer, containing all lines.
     */
    text: string

}
/**
 * We need a test case context to help with catching listeners that timed-out,
 * and synchronize multiple listeners so that when one resolves the test case,
 * the others can be put in "sleep mode" until destruction.
 */
class TestCaseContext {

    constructor(
        /**
         * A name associated with this context, to help with debugging.
         */
        readonly name: string,
        /**
         * The characters to send in order to submit a command (mostly
         * powershell is causing issues).
         */
        public submit = '\n',
        /**
         * @internal Current state of the test case, if it is finished or not.
         */
        public resolved = false
    ) { }

    resolve(): void {
        this.resolved = true;
    }

    finalize(): void {
        if (!this.resolved) {
            this.resolve();
            debug(red(`${bold(`${this.name} CONTEXT:`)} context wasn't resolved when finalizing, resolving!`));
        }
    }

}
