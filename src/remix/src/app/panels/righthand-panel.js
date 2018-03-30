var yo = require('yo-yo')
var remixLib = require('remix-lib')
var EventManager = remixLib.EventManager
var TabbedMenu = require('../tabs/tabbed-menu')
var runTab = require('../tabs/run-tab')
var debuggerTab = require('../tabs/debugger-tab')
var pluginTab = require('../tabs/plugin-tab')
var PluginManager = require('../../pluginManager')

var css = require('./styles/righthand-panel-styles')

//From editor panel
var Terminal = require('./terminal')
var styles = require('./styles/editor-panel-styles')
var cssTabs = styles.cssTabs
var cssEditor = styles.css

function RighthandPanel (appAPI, events, opts) {
  var self = this
  self._api = appAPI
  self.event = new EventManager()
  self._view = {}

  //Editor panel connection with terminal
  self.data = {
    _FILE_SCROLL_DELTA: 200,
    _layout: {
      top: {
        offset: self._api.config.get('terminal-top-offset') || 500,
        show: true
      }
    }
  }
  self._view = {}
  self._components = {
    editor: null, // no editor here
    terminal: new Terminal({
      api: {
        getPosition (event) {
          var limitUp = 36
          var limitDown = 20
          var height = window.innerHeight
          var newpos = (event.pageY < limitUp) ? limitUp : event.pageY
          newpos = (newpos < height - limitDown) ? newpos : height - limitDown
          return newpos
        },
        web3 () {
          return self._api.web3()
        },
        context () {
          return self._api.context()
        }
      }
    })
  }
  self._components.terminal.event.register('filterChanged', (type, value) => {
    this.event.trigger('terminalFilterChanged', [type, value])
  })
  self._components.terminal.event.register('resize', delta => self._adjustLayout('top', delta))
  if (self._api.txListener) {
    self._components.terminal.event.register('listenOnNetWork', (listenOnNetWork) => {
      self._api.txListener.setListenOnNetwork(listenOnNetWork)
    })
  }
  if (document && document.head) {
    document.head.appendChild(cssTabs)
  }

  self._adjustLayout = function(direction, delta) {
    var limitUp = 0
    var limitDown = 32
    var containerHeight = window.innerHeight - limitUp // - menu bar containerHeight
    var self = this
    var layout = self.data._layout[direction]
    if (layout) {
      if (delta === undefined) {
        layout.show = !layout.show
        if (layout.show) delta = layout.offset
        else delta = containerHeight
      } else {
        layout.show = true
        self._api.config.set(`terminal-${direction}-offset`, delta)
        layout.offset = delta
      }
    }
    var tmp = delta - limitDown
    delta = tmp > 0 ? tmp : 0
    if (direction === 'top') {
      var height = containerHeight - delta
      height = height < 0 ? 0 : height
      self._view.editor.style.height = `${delta}px`
      self._view.terminal.style.height = `${height}px` // - menu bar height
      //self._components.editor.resize((document.querySelector('#editorWrap') || {}).checked)
      self._components.terminal.scroll2bottom()
    }
  }
  self.refresh = function() {
    var self = this
    self._view.tabs.onmouseenter()
  }
  self.log = function(data = {}) {
    var self = this
    var command = self._components.terminal.commands[data.type]
    if (typeof command === 'function') command(data.value)
  }
  self.render = function() {
    var self = this
    if (self._view.el) return self._view.el
    self._view.editor = self._view.element
    self._view.terminal = self._components.terminal.render()
    self._view.content = yo`
      <div class=${cssEditor.content}>
        ${self._view.editor}
        ${self._view.terminal}
      </div>
    `
    self._view.el = yo`
      <div class=${cssEditor.editorpanel}>
        ${self._view.content}
      </div>
    `
    // INIT
    self._adjustLayout('top', self.data._layout.top.offset)
    return self._view.el
  }
  self.registerCommand = function(name, command, opts) {
    var self = this
    return self._components.terminal.registerCommand(name, command, opts)
  }
  self.updateTerminalFilter = function(filter) {
    this._components.terminal.updateJournal(filter)
  }

  var optionViews = yo`<div id="optionViews"></div>`
  var options = yo`
    <ul class=${css.opts}>
    </ul>
  `
  self._view.dragbar = yo`<div id="dragbar" class=${css.dragbar}></div>`
  self._view.element = yo`
    <div id="righthand-panel" class=${css.panel}>
      ${self._view.dragbar}
      <div id="header" class=${css.header}>
        <div class=${css.menu}>
          ${options}
        </div>
        ${optionViews}
      </div>
    </div>
  `
  appAPI.switchTab = (tabClass) => {
    this.event.trigger('switchTab', [tabClass])
  }

  // load tabbed menu component
  var tabEvents = {compiler: events.compiler, app: events.app, rhp: self.event}
  self._view.tabbedMenu = new TabbedMenu(options, tabEvents)

  events.rhp = self.event

  this._view.tabbedMenu.addTab('Run', 'runView', runTab(optionViews, appAPI, events))
  this._view.tabbedMenu.addTab('Debugger', 'debugView', debuggerTab(optionViews))
  this._view.tabbedMenu.selectTabByTitle('Run')

  self.pluginManager = new PluginManager(appAPI, events)
  events.rhp.register('plugin-loadRequest', (json) => {
    var content = pluginTab(optionViews, json.url)
    this._view.tabbedMenu.addTab(json.title, 'plugin', content)
    self.pluginManager.register(json, content)
  })

  //self.render = function () { return self._view.element } now taken from editor panel

  self.init = function () {
    ;[...options.children].forEach((el) => { el.classList.add(css.options) })

    // ----------------- resizeable ui ---------------
    var limit = 60
    self._view.dragbar.addEventListener('mousedown', mousedown)
    var ghostbar = yo`<div class=${css.ghostbar}></div>`
    function mousedown (event) {
      event.preventDefault()
      if (event.which === 1) {
        moveGhostbar(event)
        document.body.appendChild(ghostbar)
        document.addEventListener('mousemove', moveGhostbar)
        document.addEventListener('mouseup', removeGhostbar)
        document.addEventListener('keydown', cancelGhostbar)
      }
    }
    function cancelGhostbar (event) {
      if (event.keyCode === 27) {
        document.body.removeChild(ghostbar)
        document.removeEventListener('mousemove', moveGhostbar)
        document.removeEventListener('mouseup', removeGhostbar)
        document.removeEventListener('keydown', cancelGhostbar)
      }
    }
    function getPosition (event) {
      var lhp = window['filepanel'].offsetWidth
      var max = document.body.offsetWidth - limit
      var newpos = (event.pageX > max) ? max : event.pageX
      newpos = (newpos > (lhp + limit)) ? newpos : lhp + limit
      return newpos
    }
    function moveGhostbar (event) { // @NOTE VERTICAL ghostbar
      ghostbar.style.left = getPosition(event) + 'px'
    }
    function removeGhostbar (event) {
      document.body.removeChild(ghostbar)
      document.removeEventListener('mousemove', moveGhostbar)
      document.removeEventListener('mouseup', removeGhostbar)
      document.removeEventListener('keydown', cancelGhostbar)
      self.event.trigger('resize', [document.body.offsetWidth - getPosition(event)])
    }
  }
}

module.exports = RighthandPanel
