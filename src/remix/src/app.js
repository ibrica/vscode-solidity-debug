'use strict'

var $ = require('jquery')
var csjs = require('csjs-inject')
var yo = require('yo-yo')
var remixLib = require('remix-lib')
var EventManager = remixLib.EventManager

var UniversalDApp = require('./universal-dapp.js')
var UniversalDAppUI = require('./universal-dapp-ui.js')
var OffsetToLineColumnConverter = require('./lib/offsetToLineColumnConverter')
var QueryParams = require('./lib/query-params')

var Storage = remixLib.Storage
var Config = require('./config')
var Compiler = require('remix-solidity').Compiler
var executionContext = require('./execution-context')
var Debugger = require('./app/debugger/debugger')
var RighthandPanel = require('./app/panels/righthand-panel')
var modalDialogCustom = require('./app/ui/modal-dialog-custom')
var TxLogger = require('./app/execution/txLogger')
var Txlistener = remixLib.execution.txListener
var EventsDecoder = remixLib.execution.EventsDecoder

var styleGuide = remixLib.ui.themeChooser
var styles = styleGuide.chooser()

var css = csjs`
  html { box-sizing: border-box; }
  *, *:before, *:after { box-sizing: inherit; }
  body                 {
    font: 14px/1.5 Lato, "Helvetica Neue", Helvetica, Arial, sans-serif;
    margin             : 0;
    padding            : 0;
    font-size          : 12px;
    color              : ${styles.leftPanel.text_Primary};
    font-weight        : normal;
  }
  pre {
    overflow-x: auto;
  }
  .browsersolidity     {
    position           : relative;
    width              : 100vw;
    height             : 100vh;
    overflow           : hidden;
  }
  .rightpanel          {
    background-color  : ${styles.rightPanel.backgroundColor_Panel};
    display            : flex;
    flex-direction     : column;
    position           : absolute;
    top                : 0;
    right              : 0;
    bottom             : 0;
    overflow           : hidden;
  }
`

class App {
  constructor (opts = {}) {
    var self = this
    self._api = {}
    var fileStorage = new Storage('sol:')
    self._api.config = new Config(fileStorage)
    executionContext.init(self._api.config)
    self._view = {}
    self._components = {}
    self.data = {
      _layout: {
        right: {
          offset: self._api.config.get('right-offset') || 400,
          show: true
        }, // @TODO: adapt sizes proportionally to browser window size
        left: {
          offset: self._api.config.get('left-offset') || 200,
          show: true
        }
      }
    }

    //  Events from VS Code editor
    self.editorEvent = new EventManager()
    //Browser websocket object
    let ws = new WebSocket('ws://localhost:18080'); //port hardcoded
    ws.onopen = function() {
      ws.onmessage = function(evt) {
        console.log(`Message received: ${evt.data}`)
        let message = JSON.parse(evt.data)
        //This is event msg like breakpoint added
        if (message.event){
          self.editorEvent.trigger(message.event, message.data) //message.data should be array
        }
      }
      ws.send('Connection established!')
    }
    self.ws = ws;
  /*
    Events:
    sourceRequest
    sourceResponse
    breakpointCleared
    allBreakpointsCleared
    breakpointAdded
    breakpointHit
    stopped
    end
  */

    //Ask editor to send me source
    self.editorEvent.register('sourceRequest', _ => {
      self.ws.send(JSON.stringify({event: 'sourceRequest'}))
    })

    //Received source content
    self.editorEvent.register('sourceResponse', (target, content) => {
      self.target = target
      self.content = content
      self.runCompiler()
      //Bug from  browser-solidity, why do I have to run it twice
      setTimeout( self.runCompiler, 2000)
    })

    //Stopped at breakpoint
    self.editorEvent.register('breakpointHit', sourceLocation => {
      self.ws.send(JSON.stringify({event:'breakpointHit', data: [sourceLocation]}))
    })

    //Stopped (debugger step)
    self.editorEvent.register('stopped', (lineColumnPos, rawLocation)  => {
      self.ws.send(JSON.stringify({event:'stopped', data: [lineColumnPos, rawLocation]}))
    })

    //Debug ended
    self.editorEvent.register('end', _ => {
      self.ws.send(JSON.stringify({event: 'end'}))
    })
  }

  _adjustLayout (direction, delta) {
    var self = this
    var layout = self.data._layout[direction]
    if (layout) {
      if (delta === undefined) {
        layout.show = !layout.show
        if (layout.show) delta = layout.offset
        else delta = 0
      } else {
        self._api.config.set(`${direction}-offset`, delta)
        layout.offset = delta
      }
    }
  }

  init () {
    var self = this
    run.apply(self)
  }
  render () {
    var self = this
    if (self._view.el) return self._view.el


    self._view.rightpanel = yo`
      <div class=${css.rightpanel}>
        ${''}
      </div>
    `
    self._view.el = yo`
      <div class=${css.browsersolidity}>
        ${self._view.rightpanel}
      </div>
    `
    // INIT
    self._adjustLayout('left', self.data._layout.left.offset)
    self._adjustLayout('right', self.data._layout.right.offset)
    return self._view.el
  }
}

module.exports = App

function run () {
  var self = this
  // ----------------- Compiler -----------------
  var compiler = new Compiler();

  var offsetToLineColumnConverter = new OffsetToLineColumnConverter(compiler.event)
  // ----------------- UniversalDApp -----------------
  var transactionContextAPI = {
    getAddress: (cb) => {
      cb(null, $('#txorigin').val())
    },
    getValue: (cb) => {
      try {
        var number = document.querySelector('#value').value
        var select = document.getElementById('unit')
        var index = select.selectedIndex
        var selectedUnit = select.querySelectorAll('option')[index].dataset.unit
        var unit = 'ether' // default
        if (selectedUnit === 'ether') {
          unit = 'ether'
        } else if (selectedUnit === 'finney') {
          unit = 'finney'
        } else if (selectedUnit === 'gwei') {
          unit = 'gwei'
        } else if (selectedUnit === 'wei') {
          unit = 'wei'
        }
        cb(null, executionContext.web3().toWei(number, unit))
      } catch (e) {
        cb(e)
      }
    },
    getGasLimit: (cb) => {
      cb(null, $('#gasLimit').val())
    }
  }

  var udapp = new UniversalDApp({
    api: {
      logMessage: (msg) => {
        //Should we send it to VS code
        self._components.righthandpanel.log({ type: 'log', value: msg })
      },
      config: self._api.config,
      detectNetwork: (cb) => {
        executionContext.detectNetwork(cb)
      },
      personalMode: () => {
        return self._api.config.get('settings/personal-mode')
      }
    },
    opt: { removable: false, removable_instances: true }
  })

  var udappUI = new UniversalDAppUI(udapp)

  udapp.reset({}, transactionContextAPI)
  udappUI.reset()
  udapp.event.register('debugRequested', this, function (txResult) {
    startdebugging(txResult.transactionHash)
  })

  // ----------------- Tx listener -----------------
  var transactionReceiptResolver = {
    _transactionReceipts: {},
    resolve: function (tx, cb) {
      if (this._transactionReceipts[tx.hash]) {
        return cb(null, this._transactionReceipts[tx.hash])
      }
      executionContext.web3().eth.getTransactionReceipt(tx.hash, (error, receipt) => {
        if (!error) {
          this._transactionReceipts[tx.hash] = receipt
          cb(null, receipt)
        } else {
          cb(error)
        }
      })
    }
  }

  var compiledContracts = function () {
    if (compiler.lastCompilationResult && compiler.lastCompilationResult.data) {
      return compiler.lastCompilationResult.data.contracts
    }
    return null
  }
  var txlistener = new Txlistener({
    api: {
      contracts: compiledContracts,
      resolveReceipt: function (tx, cb) {
        transactionReceiptResolver.resolve(tx, cb)
      }
    },
    event: {
      udapp: udapp.event
    }})

  var eventsDecoder = new EventsDecoder({
    api: {
      resolveReceipt: function (tx, cb) {
        transactionReceiptResolver.resolve(tx, cb)
      }
    }
  })

  txlistener.startListening()

  this.event = new EventManager()
  var queryParams = new QueryParams()

  var config = self._api.config
  // ---------------- Righthand-panel --------------------

  var rhpAPI = {
    //from editor api
    txListener: txlistener,
    config: config,
    getAccounts: (cb) => {
      udapp.getAccounts(cb)
    },
    getSource: (fileName) => {
      return compiler.getSource(fileName)
    },
    currentFile: () => {
      return config.get('currentFile')
    },
    getContracts: () => {
      return compiler.getContracts()
    },
    getContract: (name) => {
      return compiler.getContract(name)
    },
    visitContracts: (cb) => {
      compiler.visitContracts(cb)
    },
    udapp: () => {
      return udapp
    },
    udappUI: () => {
      return udappUI
    },
    getBalance: (address, callback) => {
      udapp.getBalance(address, (error, balance) => {
        if (error) {
          callback(error)
        } else {
          callback(null, executionContext.web3().fromWei(balance, 'ether'))
        }
      })
    },
    compilationMessage: (message, container, options) => {
      // renderer.error(message, container, options)
    },
    currentCompiledSourceCode: () => {
      if (compiler.lastCompilationResult.source) {
        return compiler.lastCompilationResult.source.sources[compiler.lastCompilationResult.source.target]
      }
      return ''
    },
    resetDapp: (contracts) => {
      udapp.reset(contracts, transactionContextAPI)
      udappUI.reset()
    },
    setOptimize: (optimize, runCompilation) => {
      compiler.setOptimize(optimize)
      if (runCompilation) runCompiler()
    },
    loadCompiler: (usingWorker, url) => {
      compiler.loadVersion(usingWorker, url)
    },
    runCompiler: () => {
      runCompiler()
    },
    logMessage: (msg) => {
      self._components.righthandpanel.log({ type: 'log', value: msg })
    },

    getCompilationResult: () => {
      return compiler.lastCompilationResult
    },
    newAccount: (pass, cb) => {
      udapp.newAccount(pass, cb)
    }
  }

  var rhpEvents = {
    compiler: compiler.event,
    app: self.event,
    udapp: udapp.event
  }
  self._components.righthandpanel = new RighthandPanel(rhpAPI, rhpEvents, {})
  self._view.rightpanel.appendChild(self._components.righthandpanel.render())
  self._components.righthandpanel.init()
  self._components.righthandpanel.event.register('resize', delta => self._adjustLayout('right', delta))

  // ----------------- Debugger -----------------
  var previousInput = ''



  var debugAPI = {
    statementMarker: null,
    fullLineMarker: null,
    source: null,
    currentSourceLocation: (lineColumnPos, location) => {
      /*
      if (this.statementMarker) editor.removeMarker(this.statementMarker, this.source)
      if (this.fullLineMarker) editor.removeMarker(this.fullLineMarker, this.source)
      this.statementMarker = null
      this.fullLineMarker = null
      this.source = null
      if (lineColumnPos) {
        this.source = compiler.getSourceName(location.file)
        if (config.get('currentFile') !== this.source) {
          fileManager.switchFile(this.source)
        }
        this.statementMarker = editor.addMarker(lineColumnPos, this.source, css.highlightcode)
        editor.scrollToLine(lineColumnPos.start.line, true, true, function () {})
        if (lineColumnPos.start.line === lineColumnPos.end.line) {
          this.fullLineMarker = editor.addMarker({
            start: {
              line: lineColumnPos.start.line,
              column: 0
            },
            end: {
              line: lineColumnPos.start.line + 1,
              column: 0
            }
          }, this.source, css.highlightcode_fullLine)
        }
      }
      */
    },
    lastCompilationResult: () => {
      return compiler.lastCompilationResult
    },
    offsetToLineColumn: (location, file) => {
      return offsetToLineColumnConverter.offsetToLineColumn(location, file, compiler.lastCompilationResult)
    }
  }

  var transactionDebugger = new Debugger('#debugger', debugAPI, this.editorEvent)
  transactionDebugger.addProvider('vm', executionContext.vm())
  transactionDebugger.addProvider('web3', executionContext.internalWeb3())
  //transactionDebugger.switchProvider(executionContext.getProvider()) this creates problem, hardcode vm for now
  transactionDebugger.switchProvider('vm');

  var txLogger = new TxLogger({
    api: {
      editorpanel: self._components.righthandpanel, //terminal is now in RHP
      resolvedTransaction: function (hash) {
        return txlistener.resolvedTransaction(hash)
      },
      parseLogs: function (tx, contractName, contracts, cb) {
        eventsDecoder.parseLogs(tx, contractName, contracts, cb)
      },
      compiledContracts: function () {
        return compiledContracts()
      }
    },
    events: {
      txListener: txlistener.event
    }
  })

  txLogger.event.register('debugRequested', (hash) => {
    startdebugging(hash)
  })

  //Read source file and run compiler
  function runCompiler (source) {
    if (transactionDebugger.isActive) return

    let sources = {}
    let fileSource = getContractToCompile()
    let target = fileSource.target
    let content = fileSource.content
    sources[target] = { content }
    compiler.compile(sources, target)
  }

  self.runCompiler = runCompiler

  executionContext.event.register('contextChanged', this, function (context) {
    runCompiler()
  })

  executionContext.event.register('web3EndpointChanged', this, function (context) {
    runCompiler()
  })

  compiler.event.register('compilerLoaded', this, function (version) {
    previousInput = ''
    //Instead of running compiler, trigger sourceRequest
    self.editorEvent.trigger('sourceRequest')

    if (queryParams.get().context) {
      let context = queryParams.get().context
      let endPointUrl = queryParams.get().endPointUrl
      executionContext.setContext(context, endPointUrl,
        () => {
          modalDialogCustom.confirm(null, 'Are you sure you want to connect to an ethereum node?', () => {
            if (!endPointUrl) {
              endPointUrl = 'http://localhost:8545'
            }
            modalDialogCustom.prompt(null, 'Web3 Provider Endpoint', endPointUrl, (target) => {
              executionContext.setProviderFromEndpoint(target, context)
            }, () => {})
          }, () => {})
        },
        (alertMsg) => {
          modalDialogCustom.alert(alertMsg)
        })
    }

    if (queryParams.get().debugtx) {
      startdebugging(queryParams.get().debugtx)
    }
  })

  function startdebugging (txHash) {
    self.event.trigger('debuggingRequested', [])
    transactionDebugger.debug(txHash)
  }

  function getContractToCompile(){
    let target = self.target
    let content = self.content
    if(self.target){
      target = target.trim()
      content = content.trim()
    }
    /*
    console.log(target)
    console.log(content)
    */
    /* This is for test, ballot contract
    content = `
    pragma solidity ^0.4.0;
    contract Ballot {

        struct Voter {
            uint weight;
            bool voted;
            uint8 vote;
            address delegate;
        }
        struct Proposal {
            uint voteCount;
        }

        address chairperson;
        mapping(address => Voter) voters;
        Proposal[] proposals;

        /// Create a new ballot with $(_numProposals) different proposals.
        function Ballot(uint8 _numProposals) {
            chairperson = msg.sender;
            voters[chairperson].weight = 1;
            proposals.length = _numProposals;
        }

        /// Give $(voter) the right to vote on this ballot.
        /// May only be called by $(chairperson).
        function giveRightToVote(address voter) {
            if (msg.sender != chairperson || voters[voter].voted) return;
            voters[voter].weight = 1;
        }

        /// Delegate your vote to the voter $(to).
        function delegate(address to) {
            Voter sender = voters[msg.sender]; // assigns reference
            if (sender.voted) return;
            while (voters[to].delegate != address(0) && voters[to].delegate != msg.sender)
                to = voters[to].delegate;
            if (to == msg.sender) return;
            sender.voted = true;
            sender.delegate = to;
            Voter delegate = voters[to];
            if (delegate.voted)
                proposals[delegate.vote].voteCount += sender.weight;
            else
                delegate.weight += sender.weight;
        }

        /// Give a single vote to proposal $(proposal).
        function vote(uint8 proposal) {
            Voter sender = voters[msg.sender];
            if (sender.voted || proposal >= proposals.length) return;
            sender.voted = true;
            sender.vote = proposal;
            proposals[proposal].voteCount += sender.weight;
        }

        function winningProposal() constant returns (uint8 winningProposal) {
            uint256 winningVoteCount = 0;
            for (uint8 proposal = 0; proposal < proposals.length; proposal++)
                if (proposals[proposal].voteCount > winningVoteCount) {
                    winningVoteCount = proposals[proposal].voteCount;
                    winningProposal = proposal;
                }
        }
    }`
    */
    return  {target, content}
  }
}
