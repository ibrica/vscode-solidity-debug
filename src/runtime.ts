import {Server as WebSocketServer} from 'ws';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';


export interface SolidityBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

/**
 *  Runtime, connection over websockets with Remix debugger
 */
export class Runtime extends EventEmitter {

	// file name getter
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}

	//Websocket server
	private server:WebSocketServer;

	// the content of a source file
	private _sourceText: string;

	// the contents (= lines)
	private _sourceLines: string[];

	// This is the next line that will be 'executed'
	private _currentLine = 0;

	//WebSocket to remix
	private _ws;

	// maps from sourceFile to array of breakpoints
	private _breakPoints = new Map<string, SolidityBreakpoint[]>();

	//  id of the event and of the breakpoint.
	private _breakpointId = 1;

	private constructor() {
		super();
	}

	/**
	 * Factory method
	 */
	public static CreateAsync = async () => {
		const runtime = new Runtime();

		await runtime.startServer();

		return runtime;
	};


	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean) {

		this.loadSource(program);
		this._currentLine = -1;

		this.verifyBreakpoints(this._sourceFile);

		if (stopOnEntry) { //Stop debugger on first line, contract not yet implemented
			this._currentLine = 0;
			this.sendEvent('stopOnEntry');
		}
	}

	/*
	 * Set breakpoint in file with given line.
	 * VSCode on every change sends cleared event and then breakpoints one by one
	 */
	public setBreakPoint(path: string, line: number) : SolidityBreakpoint {

		const bp = <SolidityBreakpoint> { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<SolidityBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		this.verifyBreakpoints(path);

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : SolidityBreakpoint | undefined {
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				//Send to remix debugger
				this.sendRemixEvent('breakpointCleared', [this._sourceFile, line]);
				return bp;
			}
		}
		return undefined;
	}

	/**
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		//Send to remix debugger
		this.sendRemixEvent('allBreakpointsCleared', [this._sourceFile]);
		this._breakPoints.delete(path);
	}




	/**
	 * Fire event for debug adapter
	 * @param event
	 * @param data
	 */
	public sendEvent(event: string, data ? : any): void {
		setImmediate(_ => {
			this.emit(event, data);
		});
	}

	/**
	 * Stop websocket server
	 */
	public Stop(): void{
		//WS Bug, should be solved in node > 6
		const _server = this.server._server;
		this.server.close(function(){
			_server.close();
		});
	}


	// private methods

	/**
	 * Load content of source file in local variable
	 */
	private loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			// Source as text
			this._sourceText = readFileSync(this._sourceFile).toString();
			// All lines in source
			this._sourceLines = this._sourceText.split('\n');
		}
	}

	/**
	 * Check all breakpoint
	 */
	private verifyBreakpoints(path: string) : void {
		let bps = this._breakPoints.get(path);
		if (bps) {
			// this.loadSource(path); assuming for now source is unchanged
			//TODO: Check why on first run it gets only first breakpoint
			bps.forEach(bp => {
				if (!bp.verified && bp.line < this._sourceLines.length) {
					const srcLine = this._sourceLines[bp.line].trim();
					// if a line is empty or starts with '+' or '//' we don't allow to set a breakpoint but move the breakpoint down
					if (srcLine.length === 0 || srcLine.indexOf('//') === 0) {
						bp.line++;
					}
					// if a line starts with '/*' we don't allow to set a breakpoint but move the breakpoint up
					if (srcLine.indexOf('/*') === 0) {
						bp.line--;
					}
					bp.verified = true;
					this.sendRemixEvent('breakpointAdded', [ this._sourceFile, bp.line ]);
					this.sendEvent('breakpointValidated', bp);
				}
			});
		}
	}

	/**
	 * Send all breakpoints for file, one by one
	 */
	private sendBreakpoints(path: string): void {
		//send clear all before sending bps
		this.sendRemixEvent('allBreakpointsCleared', [this._sourceFile]);
		let bps = this._breakPoints.get(path);
		if (bps) {
			// this.loadSource(path); assuming for now source is unchanged
			bps.forEach(bp => {
				if (bp.verified && bp.line < this._sourceLines.length) {
					this.sendRemixEvent('breakpointAdded', [ this._sourceFile, bp.line ]);
				}
			});
		}
	}

	/**
	 * Start websocket server
	 */
	private startServer(): WebSocketServer{
		return new Promise( resolve  => {
			// authentication is done on the WebSocket, so any user on the local host
			// can connect to it.
			this.server = new WebSocketServer({port: 18080}); //Use 18080 for now
			this.server.on('listening', () => {
				this.onServerListening();
				resolve();
			});
		});
	}

	/**
	 * Configure Websocket conection
	 */
	private onServerListening() {
		this.server.on('connection', ws => {
			this._ws = ws; //Now set ws
			// Message must always be a string, never a Buffer.
			ws.on('message', message => {
				if (typeof message === 'string') {
					console.log(`Message received: ${message}`);
					try {
						let o = JSON.parse(message);
						if (o && typeof o === "object" && o.event) {
							// it's event from debugger, do something!
							switch(o.event){
								case 'sourceRequest': //Send debugger a source file
									this.sendRemixEvent('sourceResponse',[ this._sourceFile, this._sourceText]);
									//Now send breakpoints
									this.sendBreakpoints(this._sourceFile);
									break;
								case 'breakpointHit':
									this.sendEvent('stopOnBreakpoint');
									break;
								case 'stopped':
									let colon;
									[colon, this._currentLine] = o.data;
									this.sendEvent('stopOnStep');
									break;
								case 'end': //Do not stop debugging just get back to beggining
									//this.sendEvent('end');
									this._currentLine = 0;
									this.sendEvent('stopOnEntry');
									break;
							}
						}
					}
					catch (e) {
						//Regular message, already logged
					}
				} else {
					console.error(`Unhandled message type: ${typeof message}`);
				}
			});
		});
	}

	/**
	 * Send event to remix over websocket
	 */
	private sendRemixEvent( event :string, data ? :Array<any> ){
		let response = {
			event,
			data
		}
		if (this._ws){ //Check if connection is set
			this._ws.send(JSON.stringify(response));
		}

	}
}