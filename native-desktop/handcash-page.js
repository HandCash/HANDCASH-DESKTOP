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
  var durableToken = window.__HANDCASH_DURABLE_TOKEN__ || '';
  try { delete window.__HANDCASH_DURABLE_TOKEN__; } catch (e) { window.__HANDCASH_DURABLE_TOKEN__ = ''; }
  var subs = {
    'http-request': new Set(),
    'http-request-cancelled': new Set(),
    'device-peer-http-request': new Set(),
    'bridge-status': new Set(),
    'update-status': new Set(),
    'app-browser-guest': new Set(),
    'screenshot:copied': new Set(),
    'omarchy:theme': new Set(),
    'engine:patch': new Set()
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

  function bytesToBase64(input) {
    var bytes;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new Error('Invalid binary payload');
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function base64ToBytes(b64) {
    var bin = atob(String(b64));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
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
    if (durableToken) xhr.setRequestHeader('X-HandCash-Token', durableToken);
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
    // Native child WebView guests (not Electron <webview>).
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
    walletCoreInfo: function () { return call('walletCoreInfo'); },
    walletCoreStrictHex: function (hex) { return call('walletCoreStrictHex', { hex: hex }); },
    walletCoreValidateRequest: function (payload) { return call('walletCoreValidateRequest', payload); },
    toolboxDb: {
      call: function (dbName, op, params) {
        return call('toolboxDbOp', {
          dbName: String(dbName || ''),
          op: String(op || ''),
          params: params && typeof params === 'object' ? params : {}
        });
      }
    },
    engine: {
      status: function () { return call('engineStatus'); },
      activateAccount: function (accountId) {
        return call('engineActivateAccount', { accountId: String(accountId || '') });
      },
      lock: function () { return call('engineLock'); },
      importBrc38: function (accountId, generation, json) {
        return call('engineImportBrc38', {
          accountId: String(accountId || ''),
          generation: Number(generation || 0),
          json: String(json || '')
        });
      },
      readBalance: function (accountId, generation) {
        return call('engineReadBalance', {
          accountId: String(accountId || ''),
          generation: Number(generation || 0)
        });
      },
      readItemsPage: function (payload) { return call('engineReadItemsPage', payload || {}); },
      readActivityPage: function (payload) { return call('engineReadActivityPage', payload || {}); },
      encryptBrc39: function (json, password) {
        return call('engineEncryptBrc39', {
          json: String(json || ''),
          password: String(password || '')
        }).then(function (res) {
          return base64ToBytes(res && res.bytesBase64 ? res.bytesBase64 : '');
        });
      },
      decryptBrc39: function (bytes, password) {
        return call('engineDecryptBrc39', {
          bytesBase64: bytesToBase64(bytes),
          password: String(password || '')
        }).then(function (res) {
          return res && typeof res.json === 'string' ? res.json : '';
        });
      },
      hydrateInputs: function (payload) { return call('engineHydrateInputs', payload || {}); },
      verifyBeef: function (payload) {
        var opts = payload || {};
        return call('engineVerifyBeef', {
          accountId: String(opts.accountId || ''),
          generation: Number(opts.generation || 0),
          beefBase64: opts.beefBytes ? bytesToBase64(opts.beefBytes) : String(opts.beefBase64 || ''),
          subjectTxid: opts.subjectTxid ? String(opts.subjectTxid) : undefined
        });
      },
      verifyBrc150: function (payload) {
        var opts = payload || {};
        return call('engineVerifyBrc150', {
          accountId: String(opts.accountId || ''),
          generation: Number(opts.generation || 0),
          tipOutpoint: String(opts.tipOutpoint || ''),
          expectedOrigin: opts.expectedOrigin ? String(opts.expectedOrigin) : undefined,
          beefBase64: opts.beefBytes ? bytesToBase64(opts.beefBytes) : (opts.beefBase64 ? String(opts.beefBase64) : undefined)
        });
      },
      syncHeaders: function (accountId, generation) {
        return call('engineSyncHeaders', {
          accountId: String(accountId || ''),
          generation: Number(generation || 0)
        });
      },
      runProofPoll: function (accountId, generation) {
        return call('engineRunProofPoll', {
          accountId: String(accountId || ''),
          generation: Number(generation || 0)
        });
      },
      runBrc150Pass: function (accountId, generation, maxItems) {
        return call('engineRunBrc150Pass', {
          accountId: String(accountId || ''),
          generation: Number(generation || 0),
          maxItems: Number(maxItems || 2)
        });
      },
      sealDeltaSegment: function (accountId, generation) {
        return call('engineSealDeltaSegment', {
          accountId: String(accountId || ''),
          generation: Number(generation || 0)
        });
      },
      onPatch: function (handler) { return subscribe('engine:patch', handler); }
    },
    getUpdateStatus: function () { return call('getUpdateStatus'); },
    checkForUpdates: function () { return call('checkForUpdates'); },
    downloadUpdate: function () { return call('downloadUpdate'); },
    installUpdate: function () { return call('installUpdate').then(function () {}); },
    setUpdateMode: function (mode) { return call('setUpdateMode', { mode: mode }); },
    onUpdateStatus: function (handler) {
      var unsub = subscribe('update-status', handler);
      call('startUpdateChecks').catch(function () {});
      return unsub;
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
    startWindowDrag: function () {
      return call('startWindowDrag');
    },
    releasePromptFocus: function () {
      return call('releasePromptFocus');
    },
    openExternal: function (url) {
      return call('openExternal', { url: String(url) });
    },
    getLogInfo: function () {
      return call('getLogInfo');
    },
    openLogs: function () {
      return call('openLogs');
    },
    readLogs: function (opts) {
      return call('readLogs', opts && typeof opts === 'object' ? opts : {});
    },
    uploadLogs: function (url) {
      return call('uploadLogs', { url: String(url || '') });
    },
    storageGetSync: storeGet,
    storageSetSync: storeSet,
    storageSetAsync: function (key, value, opts) {
      return call('storageSetAsync', {
        key: String(key),
        value: String(value),
        allow: !!(opts && opts.allowVaultIdentityReplace)
      });
    },
    safeStorageAvailable: function () {
      return call('safeStorageAvailable');
    },
    vaultOpenError: function () {
      return call('vaultOpenError');
    },
    wipeWalletStorage: function () {
      return call('wipeWalletStorage');
    },
    archiveBrc39Snapshot: function (payload) {
      return call('archiveBrc39Snapshot', payload || {});
    },
    listBrc39Archive: function (identityKey) {
      return call('listBrc39Archive', { identityKey: String(identityKey || '') });
    },
    readBrc39Archive: function (payload) {
      return call('readBrc39Archive', payload || {});
    },
    brc39ArchiveRoot: function () {
      return call('brc39ArchiveRoot');
    },
    appendCallRecording: function (identityKey, id, seq, sealed) {
      return call('appendCallRecording', {
        identityKey: String(identityKey || ''),
        id: String(id || ''),
        seq: seq,
        sealedBase64: bytesToBase64(sealed)
      });
    },
    finishCallRecording: function (identityKey, id, sealedMeta) {
      return call('finishCallRecording', {
        identityKey: String(identityKey || ''),
        id: String(id || ''),
        sealedMetaBase64: bytesToBase64(sealedMeta)
      });
    },
    readCallRecording: function (identityKey, id) {
      return call('readCallRecording', {
        identityKey: String(identityKey || ''),
        id: String(id || '')
      }).then(function (res) {
        return {
          meta: res && res.meta ? base64ToBytes(res.meta) : null,
          parts: Array.isArray(res && res.parts) ? res.parts.map(base64ToBytes) : []
        };
      });
    },
    deleteCallRecording: function (identityKey, id) {
      return call('deleteCallRecording', {
        identityKey: String(identityKey || ''),
        id: String(id || '')
      });
    },
    clipboardWrite: function (text) {
      return call('clipboardWrite', { text: String(text) });
    },
    clipboardWriteImage: function (payload) {
      return call('clipboardWriteImage', payload || {});
    },
    saveBackupFile: function (payload) {
      if (!payload || typeof payload !== 'object') {
        return Promise.resolve({ ok: false, error: 'Invalid backup payload' });
      }
      try {
        return call('saveBackupFile', {
          filename: String(payload.filename || ''),
          bytesBase64: bytesToBase64(payload.bytes)
        });
      } catch (e) {
        return Promise.resolve({ ok: false, error: 'Invalid backup payload' });
      }
    },
    saveImageFile: function (payload) {
      return call('saveImageFile', payload || {});
    },
    copyScreenshot: function () {
      return call('copyScreenshot');
    },
    onScreenshotCopied: function (handler) {
      return subscribe('screenshot:copied', handler);
    },
    getOmarchyTheme: function () {
      return call('getOmarchyTheme');
    },
    onOmarchyTheme: function (handler) {
      return subscribe('omarchy:theme', handler);
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
    }
  };
  Object.freeze(window.handcash);

  // WebKitGTK / WebView2 ignore `-webkit-app-region` in frameless windows.
  // Match native-macos drag-region handling for `.titlebar` / `[data-aeon-drag]`.
  function appRegionFor(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hasAttribute && node.hasAttribute('data-aeon-no-drag')) return 'no-drag';
      if (node.hasAttribute && node.hasAttribute('data-aeon-drag')) return 'drag';
      var tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        return 'no-drag';
      }
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
