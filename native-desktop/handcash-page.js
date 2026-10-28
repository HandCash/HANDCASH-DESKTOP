/**
 * window.handcash facade for the thin Win/Linux host (wry ipc).
 * Platform string is injected as window.__HANDCASH_NATIVE_PLATFORM__ before this runs.
 * Sync durable store uses loopback HTTP (window.__HANDCASH_DURABLE_URL__), not prompt.
 */
(function () {
  if (window.handcash) return;
  var pending = new Map();
  var seq = 0;
  var platform = window.__HANDCASH_NATIVE_PLATFORM__ || 'linux';
  var durableBase = window.__HANDCASH_DURABLE_URL__ || '';
  var subs = {
    'http-request': new Set(),
    'http-request-cancelled': new Set(),
    'device-peer-http-request': new Set(),
    'bridge-status': new Set(),
    'update-status': new Set()
  };

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = String(++seq);
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.ipc.postMessage(
          JSON.stringify({ id: id, method: method, params: params || {} })
        );
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

  function durableAsk(body) {
    if (!durableBase) throw new Error('durable store not ready');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', durableBase + '/op', false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-HandCash-Origin', location.origin);
    xhr.send(JSON.stringify(body));
    if (xhr.status !== 200) throw new Error('durable http ' + xhr.status);
    return JSON.parse(xhr.responseText);
  }

  function storeGet(key) {
    try {
      var r = durableAsk({ op: 'get', key: String(key) });
      return r.value == null ? null : r.value;
    } catch (e) {
      console.warn(e);
      return null;
    }
  }

  function storeSet(key, value, opts) {
    try {
      var r = durableAsk({
        op: 'set',
        key: String(key),
        value: String(value),
        allow: !!(opts && opts.allowVaultIdentityReplace)
      });
      return r.ok === true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }

  window.handcash = {
    platform: platform,
    embeddedAppBrowser: false,
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
})();
