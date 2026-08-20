/* Browser-only process shape required before wallet SDK ES modules evaluate. */
;(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : window
  if (!g.process || typeof g.process !== 'object') {
    g.process = {
      env: { NETWORK: '', BASEURL: '', NODE_ENV: 'production' },
      browser: true,
      version: 'v18.0.0',
      versions: { node: '18.0.0' },
      platform: 'browser',
      title: 'browser',
      argv: [],
      pid: 0,
      cwd: function () {
        return '/'
      },
      nextTick: function (fn) {
        var args = Array.prototype.slice.call(arguments, 1)
        queueMicrotask(function () {
          fn.apply(null, args)
        })
      },
    }
    return
  }

  g.process.env = g.process.env || {}
  if (g.process.env.NETWORK === undefined) g.process.env.NETWORK = ''
  if (g.process.env.BASEURL === undefined) g.process.env.BASEURL = ''
  if (g.process.env.NODE_ENV === undefined) g.process.env.NODE_ENV = 'production'
  if (typeof g.process.cwd !== 'function') {
    g.process.cwd = function () {
      return '/'
    }
  }
  if (typeof g.process.nextTick !== 'function') {
    g.process.nextTick = function (fn) {
      var args = Array.prototype.slice.call(arguments, 1)
      queueMicrotask(function () {
        fn.apply(null, args)
      })
    }
  }
})()
