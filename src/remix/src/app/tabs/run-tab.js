'use strict'
var $ = require('jquery')
var yo = require('yo-yo')
var helper = require('../../lib/helper.js')
var remixLib = require('remix-lib')
var txExecution = remixLib.execution.txExecution
var txFormat = remixLib.execution.txFormat
var txHelper = remixLib.execution.txHelper
var executionContext = require('../../execution-context')
var modalDialogCustom = require('../ui/modal-dialog-custom')
var copyToClipboard = require('../ui/copy-to-clipboard')
var EventManager = remixLib.EventManager
var addTooltip = require('../ui/tooltip')
var QueryParams = require('../../lib/query-params')

var csjs = require('csjs-inject')
var css = require('./styles/run-tab-styles')
var settingsCss = require('./styles/settings-tab-styles')

var instanceContainer = yo`<div class="${css.instanceContainer}"></div>`
var noInstancesText = yo`<div class="${css.noInstancesText}">0 contract Instances</div>`

var pendingTxsText = yo`<span></span>`

function runTab (container, appAPI, appEvents) {
  var events = new EventManager()
  var queryParams = new QueryParams()

  var clearInstanceElement = yo`<i class="${css.clearinstance} fa fa-minus-square-o" title="Clear Instances List" aria-hidden="true"></i>`
  clearInstanceElement.addEventListener('click', () => {
    events.trigger('clearInstance', [])
  })

  var el = yo`
  <div class="${css.runTabView}" id="runTabView">
    ${compilerSettings(appAPI, appEvents)}
    ${settings(container, appAPI, appEvents)}
    ${contractDropdown(events, appAPI, appEvents, instanceContainer)}
    ${instanceContainer}
  </div>
  `
  container.appendChild(el)
  //Compiler selection
  function compilerSettings(appAPI, appEvents){
    var el = yo`
        <div class="${settingsCss.info}">
        <div class=${settingsCss.title}>Solidity version</div>
        <span>Current version:</span> <span id="version"></span>
        <div class="${settingsCss.crow}">
          <select class="${settingsCss.select}" id="versionSelector"></select>
        </div>
      </div>
    `
    // ----------------- version selector-------------

    // clear and disable the version selector
    var versionSelector = el.querySelector('#versionSelector')
    versionSelector.innerHTML = ''
    versionSelector.setAttribute('disabled', true)

    // load the new version upon change
    versionSelector.addEventListener('change', function () {
      loadVersion(versionSelector.value, queryParams, appAPI, el)
    })

    var header = new Option('Select new compiler version')
    header.disabled = true
    header.selected = true
    versionSelector.appendChild(header)

    $.getJSON('https://ethereum.github.io/solc-bin/bin/list.json').done(function (data) {
      // populate version dropdown with all available compiler versions (descending order)
      $.each(data.builds.slice().reverse(), function (i, build) {
        versionSelector.appendChild(new Option(build.longVersion, build.path))
      })

      versionSelector.removeAttribute('disabled')

      // always include the local version
      versionSelector.appendChild(new Option('latest local version', 'builtin'))

      // find latest release
      var selectedVersion = data.releases[data.latestRelease]

      // override with the requested version
      if (queryParams.get().version) {
          selectedVersion = queryParams.get().version
      }

      loadVersion(selectedVersion, queryParams, appAPI, el)
    }).fail(function (xhr, text, err) {
      // loading failed for some reason, fall back to local compiler
      versionSelector.append(new Option('latest local version', 'builtin'))

      loadVersion('builtin', queryParams, appAPI, el)
    })

    function setVersionText (text, el) {
      el.querySelector('#version').innerText = text
    }

    function loadVersion (version, queryParams, appAPI, el) {
      queryParams.update({ version: version })
      var url
      if (version === 'builtin') {
        var location = window.document.location
        location = location.protocol + '//' + location.host + '/' + location.pathname
        if (location.endsWith('index.html')) {
          location = location.substring(0, location.length - 10)
        }
        if (!location.endsWith('/')) {
          location += '/'
        }

        url = location + 'soljson.js'
      } else {
        if (version.indexOf('soljson') !== 0 || helper.checkSpecialChars(version)) {
          console.log('loading ' + version + ' not allowed')
          return
        }
        url = 'https://ethereum.github.io/solc-bin/bin/' + version
      }
      var isFirefox = typeof InstallTrigger !== 'undefined'
      if (document.location.protocol !== 'file:' && Worker !== undefined && isFirefox) {
        // Workers cannot load js on "file:"-URLs and we get a
        // "Uncaught RangeError: Maximum call stack size exceeded" error on Chromium,
        // resort to non-worker version in that case.
        appAPI.loadCompiler(true, url)
        setVersionText('(loading using worker)', el)
      } else {
        appAPI.loadCompiler(false, url)
        setVersionText('(loading)', el)
      }
    }


    appEvents.compiler.register('compilerLoaded', (version) => {
      setVersionText(version, el)
    })

    return el
  }

  // PENDING transactions
  function updatePendingTxs (container, appAPI) {
    var pendingCount = Object.keys(appAPI.udapp().pendingTransactions()).length
    pendingTxsText.innerText = pendingCount + ' pending transactions'
  }

  // DROPDOWN
  var selectExEnv = el.querySelector('#selectExEnvOptions')

  function setFinalContext () {
    // set the final context. Cause it is possible that this is not the one we've originaly selected
    selectExEnv.value = executionContext.getProvider()
    fillAccountsList(appAPI, el)
    // Account (TX origin changed)
    el.querySelector('#txorigin').addEventListener('change', () => {
      if (document.getElementById('txorigin').value){
        appAPI.runCompiler()
      }
    })
    events.trigger('clearInstance', [])
  }

  selectExEnv.addEventListener('change', function (event) {
    let context = selectExEnv.options[selectExEnv.selectedIndex].value
    executionContext.executionContextChange(context, null, () => {
      modalDialogCustom.confirm(null, 'Are you sure you want to connect to an ethereum node?', () => {
        modalDialogCustom.prompt(null, 'Web3 Provider Endpoint', 'http://localhost:8545', (target) => {
          executionContext.setProviderFromEndpoint(target, context, (alertMsg) => {
            if (alertMsg) {
              modalDialogCustom.alert(alertMsg)
            }
            setFinalContext()
          })
        }, setFinalContext)
      }, setFinalContext)
    }, (alertMsg) => {
      modalDialogCustom.alert(alertMsg)
    }, setFinalContext)
  })
  //selectExEnv.value = executionContext.getProvider()
  selectExEnv.value = 'vm' //JS VM default

  fillAccountsList(appAPI, el)
  setInterval(() => {
    updateAccountBalances(container, appAPI)
    updatePendingTxs(container, appAPI)
  }, 10000)

  events.register('clearInstance', () => {
    instanceContainer.innerHTML = '' // clear the instances list
    noInstancesText.style.display = 'block'
    instanceContainer.appendChild(noInstancesText)
  })
  //setTimeout(()=>{ appAPI.runCompiler() })

  return el
}


function fillAccountsList (appAPI, container) {
  var $txOrigin = $(container.querySelector('#txorigin'))
  $txOrigin.empty()
  appAPI.udapp().getAccounts((err, accounts) => {
    if (err) { addTooltip(`Cannot get account list: ${err}`) }
    if (accounts && accounts[0]) {
      for (var a in accounts) { $txOrigin.append($('<option />').val(accounts[a]).text(accounts[a])) }
      $txOrigin.val(accounts[0])
    } else {
      $txOrigin.val('unknown')
    }
  })
}

function updateAccountBalances (container, appAPI) {
  var accounts = $(container.querySelector('#txorigin')).children('option')
  accounts.each(function (index, value) {
    (function (acc) {
      appAPI.getBalance(accounts[acc].value, function (err, res) {
        if (!err) {
          accounts[acc].innerText = helper.shortenAddress(accounts[acc].value, res)
        }
      })
    })(index)
  })
}

/* ------------------------------------------------
    section CONTRACT DROPDOWN and BUTTONS
------------------------------------------------ */

function contractDropdown (events, appAPI, appEvents, instanceContainer) {
  instanceContainer.appendChild(noInstancesText)
  var compFails = yo`<i title="Contract compilation failed. Please check the compile tab for more information." class="fa fa-times-circle ${css.errorIcon}" ></i>`
  appEvents.compiler.register('compilationFinished', function (success, data, source) {
    getContractNames(success, data)
    if (success) {
      compFails.style.display = 'none'
      document.querySelector(`.${css.contractNames}`).classList.remove(css.contractNamesError)
    } else {
      compFails.style.display = 'block'
      document.querySelector(`.${css.contractNames}`).classList.add(css.contractNamesError)
    }
  })

  var atAddressButtonInput = yo`<input class="${css.input} ataddressinput" placeholder="Load contract from Address" title="atAddress" />`
  var createButtonInput = yo`<input class="${css.input} create" placeholder="" title="Create" />`
  var selectContractNames = yo`<select class="${css.contractNames}" disabled></select>`

  function getSelectedContract () {
    var contractName = selectContractNames.children[selectContractNames.selectedIndex].innerHTML
    if (contractName) {
      return {
        name: contractName,
        contract: appAPI.getContract(contractName)
      }
    }
    return null
  }
  appAPI.getSelectedContract = getSelectedContract

  var el = yo`
    <div class="${css.container}">
      <div class="${css.subcontainer}">
        ${selectContractNames} ${compFails}
      </div>
      <div class="${css.buttons}">
        <div class="${css.button}">
          ${createButtonInput}
          <div class="${css.create}" onclick=${function () { createInstance() }} >Create</div>
        </div>
        <div class="${css.button}">
          ${atAddressButtonInput}
          <div class="${css.atAddress}" onclick=${function () { loadFromAddress(appAPI) }}>At Address</div>
        </div>
      </div>
    </div>
  `

  function setInputParamsPlaceHolder () {
    createButtonInput.value = ''
    if (appAPI.getContract && selectContractNames.selectedIndex >= 0 && selectContractNames.children.length > 0) {
      var ctrabi = txHelper.getConstructorInterface(getSelectedContract().contract.object.abi)
      if (ctrabi.inputs.length) {
        createButtonInput.setAttribute('placeholder', txHelper.inputParametersDeclarationToString(ctrabi.inputs))
        createButtonInput.removeAttribute('disabled')
        return
      }
    }
    createButtonInput.setAttribute('placeholder', '')
    createButtonInput.setAttribute('disabled', true)
  }

  selectContractNames.addEventListener('change', setInputParamsPlaceHolder)

  // ADD BUTTONS AT ADDRESS AND CREATE
  function createInstance () {
    var selectedContract = getSelectedContract()

    if (selectedContract.contract.object.evm.bytecode.object.length === 0) {
      modalDialogCustom.alert('This contract does not implement all functions and thus cannot be created.')
      return
    }

    var constructor = txHelper.getConstructorInterface(selectedContract.contract.object.abi)
    var args = createButtonInput.value
    txFormat.buildData(selectedContract.name, selectedContract.contract.object, appAPI.getContracts(), true, constructor, args, appAPI.udapp(), (error, data) => {
      if (!error) {
        appAPI.logMessage(`creation of ${selectedContract.name} pending...`)
        txExecution.createContract(data, appAPI.udapp(), (error, txResult) => {
          if (!error) {
            var isVM = executionContext.isVM()
            if (isVM) {
              var vmError = txExecution.checkVMError(txResult)
              if (vmError.error) {
                appAPI.logMessage(vmError.message)
                return
              }
            }
            noInstancesText.style.display = 'none'
            var address = isVM ? txResult.result.createdAddress : txResult.result.contractAddress
            instanceContainer.appendChild(appAPI.udappUI().renderInstance(selectedContract.contract.object, address, selectContractNames.value))
          } else {
            appAPI.logMessage(`creation of ${selectedContract.name} errored: ` + error)
          }
        })
      } else {
        appAPI.logMessage(`creation of ${selectedContract.name} errored: ` + error)
      }
    }, (msg) => {
      appAPI.logMessage(msg)
    })
  }

  function loadFromAddress (appAPI) {
    noInstancesText.style.display = 'none'
    var contractNames = document.querySelector(`.${css.contractNames.classNames[0]}`)
    var address = atAddressButtonInput.value
    if (/.(.abi)$/.exec(appAPI.currentFile())) {
      modalDialogCustom.confirm(null, 'Do you really want to interact with ' + address + ' using the current ABI definition ?', () => {
        var abi
        try {
          abi = JSON.parse(appAPI.editorContent())
        } catch (e) {
          return modalDialogCustom.alert('Failed to parse the current file as JSON ABI.')
        }
        instanceContainer.appendChild(appAPI.udappUI().renderInstanceFromABI(abi, address, address))
      })
    } else {
      var contract = appAPI.getContract(contractNames.children[contractNames.selectedIndex].innerHTML)
      instanceContainer.appendChild(appAPI.udappUI().renderInstance(contract.object, address, selectContractNames.value))
    }
  }

  // GET NAMES OF ALL THE CONTRACTS
  function getContractNames (success, data) {
    var contractNames = document.querySelector(`.${css.contractNames.classNames[0]}`)
    contractNames.innerHTML = ''
    if (success) {
      selectContractNames.removeAttribute('disabled')
      appAPI.visitContracts((contract) => {
        contractNames.appendChild(yo`<option>${contract.name}</option>`)
      })
    } else {
      selectContractNames.setAttribute('disabled', true)
    }
    setInputParamsPlaceHolder()
  }

  return el
}

/* ------------------------------------------------
    section SETTINGS: Environment, Account, Gas, Value
------------------------------------------------ */
function settings (container, appAPI, appEvents) {
  // SETTINGS HTML
  var net = yo`<span class=${css.network}></span>`
  const updateNetwork = () => {
    executionContext.detectNetwork((err, { id, name } = {}) => {
      if (err) {
        console.error(err)
        net.innerHTML = 'can\'t detect network '
      } else {
        net.innerHTML = `<i class="${css.networkItem} fa fa-plug" aria-hidden="true"></i> ${name} (${id || '-'})`
      }
    })
  }
  setInterval(updateNetwork, 5000)
  function newAccount () {
    appAPI.newAccount('', (error, address) => {
      if (!error) {
        container.querySelector('#txorigin').appendChild(yo`<option value=${address}>${address}</option>`)
        addTooltip(`account ${address} created`)
      } else {
        addTooltip('Cannot create an account: ' + error)
      }
    })
  }
  var el = yo`
    <div class="${css.settings}">
      <div class="${css.crow}">
        <div id="selectExEnv" class="${css.col1_1}">
          Environment
        </div>
        <div class=${css.environment}>
          ${net}
          <select id="selectExEnvOptions" onchange=${updateNetwork} class="${css.select}">
            <option id="vm-mode"
              title="Execution environment does not connect to any node, everything is local and in memory only."
              value="vm"
              name="executionContext">
              JavaScript VM
            </option>
            <option id="web3-mode" selected
              title="Execution environment connects to node at localhost (or via IPC if available), transactions will be sent to the network and can cause loss of money or worse!
              If this page is served via https and you access your node via http, it might not work. In this case, try cloning the repository and serving it via http."
              value="web3"
              name="executionContext">
              Web3 Provider
            </option>
          </select>
          <a href="https://github.com/ethereum/EIPs/blob/master/EIPS/eip-155.md" target="_blank"><i class="${css.icon} fa fa-info"></i></a>
        </div>
      </div>
      <div class="${css.crow}">
        <div class="${css.col1_1}">Account</div>
        <select name="txorigin" class="${css.select}" id="txorigin"></select>
          ${copyToClipboard(() => document.querySelector('#runTabView #txorigin').value)}
          <i class="fa fa-plus-circle ${css.icon}" aria-hidden="true" onclick=${newAccount} title="Create a new account"></i>
      </div>
      <div class="${css.crow}">
        <div class="${css.col1_1}">Gas limit</div>
        <input type="number" class="${css.col2}" id="gasLimit" value="3000000">
      </div>
      <div class="${css.crow}" style="display: none">
      <div class="${css.col1_1}">Gas Price</div>
        <input type="number" class="${css.col2}" id="gasPrice" value="0">
      </div>
      <div class="${css.crow}">
      <div class="${css.col1_1}">Value</div>
        <input type="text" class="${css.col2_1}" id="value" value="0" title="Enter the value and choose the unit">
        <select name="unit" class="${css.col2_2}" id="unit">
          <option data-unit="wei">wei</option>
          <option data-unit="gwei">gwei</option>
          <option data-unit="finney">finney</option>
          <option data-unit="ether">ether</option>
        </select>
      </div>
    </div>
  `

  // EVENTS
  appEvents.udapp.register('transactionExecuted', (error, from, to, data, lookupOnly, txResult) => {
    if (error) return
    if (!lookupOnly) el.querySelector('#value').value = '0'
    updateAccountBalances(container, appAPI)
  })

  return el
}

module.exports = runTab
