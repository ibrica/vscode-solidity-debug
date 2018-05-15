import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, Source, Breakpoint, StackFrame
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { SolidityBreakpoint, Runtime } from './runtime';
const { Subject } = require('await-notify');
import * as npmRun from 'npm-run';
import * as vscode from 'vscode';
import * as http from 'http';


/**
 * This interface describes specific launch attributes
 * The schema for these attributes lives in the package.json of the debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class SolidityDebugSession extends LoggingDebugSession {

	// no support for multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// a Websocket runtime
	private _runtime: Runtime;


	private _configurationDone = new Subject();


	/**
	 * Creates a new debug adapter that is used for one debug session.
	 */
	constructor() {
		super("solidity-debug.txt");

		//Lines start at 0
		this.setDebuggerLinesStartAt1(false);
		// debugger uses zero-based  columns
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 * removed void return type, shouldn't be a problem
	 */
	protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
		this._runtime = await Runtime.CreateAsync();


		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', SolidityDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			//Hack, call  step request to move editor highlight
			this.dispatchRequest({command:"next", seq:14,type:"request", arguments:{threadId:SolidityDebugSession.THREAD_ID}});
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', SolidityDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', SolidityDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: SolidityBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);
/*
		try {

			//TODO: Kill node process on debug stop
			npmRun.exec('npm run serve', {cwd: __dirname + '/../src/remix'}, function (err:Error, stdout, stderr) { //Doesn't return promise, callback
					if(err){
						return console.error(err);
					}
			});

			//Check if Remix is alive
			await this.pingRemixServer();

			//Now open GUI in separate window
			vscode.commands.executeCommand('extension.previewHtmlRemix');

		} catch(error){
			console.error(error);
		} */

		// start the program in the runtime
		this._runtime.start(args.program, !!args.stopOnEntry);


		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		const path = <string>args.source.path;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = clientLines.map(l => {
			let { verified, line, id } = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = <DebugProtocol.Breakpoint>new Breakpoint(verified, this.convertDebuggerLineToClient(line));
			bp.id = id;
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports now threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(SolidityDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void{
		//Stop runtime
		if (this._runtime){
			//this._runtime.Stop(); //TODO: Switch on after testing
		}

		//vscode.commands.executeCommand('workbench.action.focusRightEditor'); //No, it doesnt work, need a group command
		// Ugly, it will close real editor if we are in it, but only way to close Remix for now
		vscode.commands.executeCommand('workbench.action.closeActiveEditor');

		this.sendResponse(response);

	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stk = this._runtime.stack(startFrame, endFrame);

		response.body = {
			stackFrames: stk.frames.map(f => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
			totalFrames: stk.count

		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.sendEvent(new StoppedEvent('step', SolidityDebugSession.THREAD_ID));
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		this.sendResponse(response);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		let source = new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data')
		return source;
	}

	/**
	 * Check if Remix server is alive, wait each time 3s and after 5 times return error
	 */
	private pingRemixServer(){
		return new Promise( (resolve, reject) => {
			let i = 0,
				intervalId;
			intervalId = setInterval( _ => {
				http.get('http://localhost:8080', function (res) {
					clearInterval(intervalId);
					resolve()
				}).	on('error', function(e) {
					i++;
					if (i > 5){
						clearInterval(intervalId);
						reject('No remix on selected port!');
					}
				});
			}, 3000);
		});
	}
}
