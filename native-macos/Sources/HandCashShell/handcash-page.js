(function () {
  if (window.handcash) return;
  var pending = new Map();
  var seq = 0;
  var subs = {
    'http-request': new Set(),
    'http-request-cancelled': new Set(),
    'device-peer-http-request': new Set(),
    'bridge-status': new Set(),
    'update-status': new Set(),
    'app-browser-guest': new Set(),
    'screenshot:copied': new Set()
  };

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = String(++seq);
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.webkit.messageHandlers.handcash.postMessage({
          id: id,
          method: method,
          params: params || {}
        });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  function subscribe(channel, handler) {
    var set = subs[channel];
    if (!set) return function () {};
    set.add(handler);
    return function () {
      set.delete(handler);
    };
  }

  window.__handcashNativeReply = function (msg) {
    var p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error || 'native error'));
  };

  window.__handcashNativePush = function (msg) {
    var set = subs[msg.channel];
    if (!set) return;
    set.forEach(function (handler) {
      try {
        handler(msg.payload);
      } catch (e) {
        console.error(e);
      }
    });
  };

  function storeGet(key) {
    if (!window.HandcashDurableStore) return null;
    try {
      return window.HandcashDurableStore.get(String(key));
    } catch (e) {
      console.warn(e);
      return null;
    }
  }

  function storeSet(key, value, opts) {
    if (!window.HandcashDurableStore) return false;
    try {
      return window.HandcashDurableStore.set(
        String(key),
        String(value),
        !!(opts && opts.allowVaultIdentityReplace)
      );
    } catch (e) {
      console.warn(e);
      return false;
    }
  }

  window.handcash = {
    platform: 'darwin',
    // Native WKWebView guests (not Electron <webview>).
    embeddedAppBrowser: false,
    appBrowserGuest: {
      create: function (options) {
        return call('appBrowserGuestCreate', options);
      },
      setBounds: function (options) {
        return call('appBrowserGuestSetBounds', options);
      },
      navigate: function (options) {
        return call('appBrowserGuestNavigate', options);
      },
      capture: function (options) {
        return call('appBrowserGuestCapture', options);
      },
      destroy: function (options) {
        return call('appBrowserGuestDestroy', options);
      },
      onEvent: function (handler) {
        return subscribe('app-browser-guest', handler);
      }
    },
    getAppInfo: function () {
      return call('getAppInfo');
    },
    getBridgeStatus: function () {
      return call('getBridgeStatus');
    },
    restartBridge: function () {
      return call('restartBridge');
    },
    onBridgeStatus: function (handler) {
      return subscribe('bridge-status', handler);
    },
    onHttpRequest: function (handler) {
      var unsub = subscribe('http-request', handler);
      // Registering the listener *is* the readiness signal (matches Electron preload).
      call('announceBridgeReady').catch(function () {});
      return unsub;
    },
    announceBridgeReady: function () {
      return call('announceBridgeReady');
    },
    onDevicePeerHttpRequest: function (handler) {
      return subscribe('device-peer-http-request', handler);
    },
    onHttpRequestCancelled: function (handler) {
      return subscribe('http-request-cancelled', handler);
    },
    respondHttp: function (response) {
      return call('respondHttp', { response: response });
    },
    notePromptOpen: function (open) {
      return call('notePromptOpen', { open: !!open });
    },
    respondDevicePeerHttp: function (response) {
      return call('respondDevicePeerHttp', { response: response });
    },
    focusWindow: function () {
      return call('focusWindow');
    },
    startWindowDrag: function () {
      return call('startWindowDrag');
    },
    releasePromptFocus: function () {
      return call('releasePromptFocus');
    },
    openExternal: function (url) {
      return call('openExternal', { url: String(url) });
    },
    storageGetSync: storeGet,
    storageSetSync: storeSet,
    safeStorageAvailable: function () {
      return call('safeStorageAvailable');
    },
    vaultOpenError: function () {
      return call('vaultOpenError');
    },
    wipeWalletStorage: function () {
      return call('wipeWalletStorage');
    },
    clipboardWrite: function (text) {
      return call('clipboardWrite', { text: String(text) });
    },
    copyScreenshot: function () {
      return call('copyScreenshot');
    },
    onScreenshotCopied: function (handler) {
      return subscribe('screenshot:copied', handler);
    },
    deviceAuthStatus: function () {
      return call('deviceAuthStatus');
    },
    deviceAuthEnroll: function (secret) {
      return call('deviceAuthEnroll', { secret: String(secret) });
    },
    deviceAuthUnlock: function (reason) {
      return call('deviceAuthUnlock', { reason: reason == null ? '' : String(reason) });
    },
    deviceAuthClear: function () {
      return call('deviceAuthClear');
    },
    getUpdateStatus: function () {
      return call('getUpdateStatus');
    },
    checkForUpdates: function () {
      return call('checkForUpdates');
    },
    downloadUpdate: function () {
      return call('downloadUpdate');
    },
    setUpdateMode: function (mode) {
      return call('setUpdateMode', { mode: mode });
    },
    installUpdate: function () {
      return call('installUpdate');
    },
    onUpdateStatus: function (handler) {
      return subscribe('update-status', handler);
    }
  };
  Object.freeze(window.handcash);

  // WKWebView ignores `-webkit-app-region` and getComputedStyle usually returns
  // empty for it (Electron-only). Walk data attributes + titlebar classes, then
  // fall back to computed style for any Chromium embed.
  function appRegionFor(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hasAttribute && node.hasAttribute('data-aeon-no-drag')) return 'no-drag';
      if (node.hasAttribute && node.hasAttribute('data-aeon-drag')) return 'drag';
      if (
        node.classList &&
        (node.classList.contains('titlebar') || node.classList.contains('aeon-titlebar'))
      ) {
        return 'drag';
      }
      var region = '';
      try {
        var cs = window.getComputedStyle(node);
        region = (
          cs.getPropertyValue('-webkit-app-region') ||
          cs.getPropertyValue('app-region') ||
          ''
        ).trim();
      } catch (e) {}
      if (region === 'drag' || region === 'no-drag') return region;
    }
    return '';
  }

  document.addEventListener(
    'mousedown',
    function (e) {
      if (e.button !== 0) return;
      var target = e.target;
      if (target && target.nodeType === 3) target = target.parentElement;
      if (appRegionFor(target) !== 'drag') return;
      call('startWindowDrag').catch(function () {});
    },
    true
  );
})();
