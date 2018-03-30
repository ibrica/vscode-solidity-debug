'use strict';
import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { SolidityDebugSession } from './solidityDebug';
import * as Net from 'net';

let EMBED_DEBUG_ADAPTER = false;

const previewUri = vscode.Uri.parse('vscode-solidity-debug://authority/vscode-solidity-debug');

const textDocumentContentProvider = {
    provideTextDocumentContent(uri/*: vscode.Uri*/)/*: string*/ {
      return `
<!DOCTYPE html>
<html>
<head>
<style>
		iframe {
			width:100%;
			height:100vh
		}
		body, html {
				margin: 0; padding: 0; height: 100%; overflow: hidden;
		}
</style>
</head>
<body>
		<iframe src="http://localhost:8080"></iframe>
</body>
</html>
	`;
    },
};



// TODO: test if async here could make problems
export function activate(context: vscode.ExtensionContext) {
	// Runs before resolveDebugConfiguration and only for solidity debug, set in package.json

	// Should we prompt user for file or always use current?
	context.subscriptions.push(vscode.commands.registerCommand('extension.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of a solidity file in the workspace folder",
			value: "*.sol"
		});
	}));

	//Show remix as HTML preview when started
	let disposable = vscode.commands.registerCommand('extension.previewHtmlRemix',()=>{
		vscode.commands.executeCommand(
			'vscode.previewHtml',
			previewUri,
			vscode.ViewColumn.Two,
			'Remix'
		).then(undefined, error => console.error(error)); //Shorter then await with try-catch
	})
	context.subscriptions.push(disposable);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
		  'vscode-solidity-debug',
		  textDocumentContentProvider)
	);


	//register a configuration provider for solidity debug
	const provider = new SolidityConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('solidity', provider));
	context.subscriptions.push(provider);


}

export function deactivate() {
	// nothing to do
}

/**
 * Dynamic extension configuration
 */
class SolidityConfigurationProvider implements vscode.DebugConfigurationProvider {
	private _server?: Net.Server;
	/**
	 * Message a debug configuration just before a debug session is being launched,
	 * add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {


		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'solidity' ) {
				config.type = 'solidity';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.stopOnEntry = true;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		EMBED_DEBUG_ADAPTER = true;
		if (EMBED_DEBUG_ADAPTER) {
			// start port listener on launch of first debug session
			if (!this._server) {

				// start listening on a random port
				this._server = Net.createServer(socket => {
					const session = new SolidityDebugSession();
					session.setRunAsServer(true);
					session.start(<NodeJS.ReadableStream>socket, socket);
				}).listen(0);
			}

			// make VS Code connect to debug server instead of launching debug adapter
			config.debugServer = this._server.address().port;
		}

		return config;
	}

	dispose() {
	}
}
