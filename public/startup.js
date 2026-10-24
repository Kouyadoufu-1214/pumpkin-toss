(function () {
  'use strict';

  var status = document.getElementById('startup-status');
  var title = document.getElementById('startup-title');
  var detail = document.getElementById('startup-detail');
  var diagnostics = document.getElementById('startup-diagnostics');
  var errorText = document.getElementById('startup-error');
  var reload = document.getElementById('startup-reload');
  var state = 'loading';
  var timer = null;

  function clearWait() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function describeError(error) {
    if (error && typeof error === 'object') {
      var name = typeof error.name === 'string' ? error.name : 'Error';
      var message = typeof error.message === 'string' ? error.message : '詳しいエラー情報はありません。';
      return (name + ': ' + message).slice(0, 2000);
    }
    return String(error || '詳しいエラー情報はありません。').slice(0, 2000);
  }

  function fail(error, firstFrame) {
    if (state === 'ready' || state === 'file' || state === 'failed') return;
    state = 'failed';
    clearWait();
    status.hidden = false;
    title.textContent = firstFrame ? '画面を表示できませんでした' : 'アプリを読み込めませんでした';
    detail.textContent = '再読み込みを試してください。改善しない場合は「共有URLから開く」から開き直してください。下のエラー情報も確認できます。';
    diagnostics.hidden = false;
    errorText.textContent = describeError(error);
  }

  reload.addEventListener('click', function () { window.location.reload(); });
  window.addEventListener('pumpkin-ready', function () {
    if (state === 'file') return;
    state = 'ready';
    clearWait();
    status.hidden = true;
  });
  window.addEventListener('pumpkin-startup-error', function (event) {
    fail(event.detail && event.detail.error, true);
  });

  status.hidden = false;
  diagnostics.hidden = true;
  diagnostics.open = false;
  errorText.textContent = '';

  if (window.location.protocol !== 'https:' && window.location.protocol !== 'http:') {
    state = 'file';
    title.textContent = '公開URLから開いてください';
    detail.textContent = window.location.protocol === 'file:'
      ? '保存したHTMLファイルを直接開くと、アプリを読み込めません。「共有URLから開く」を押してください。'
      : 'この開き方ではアプリを読み込めません。「共有URLから開く」を押してください。';
    reload.hidden = true;
    return;
  }

  reload.hidden = false;
  title.textContent = 'かぼちゃ工房を準備しています';
  detail.textContent = '画面が表示されるまで、少しお待ちください。';
  timer = window.setTimeout(function () {
    if (state !== 'loading') return;
    state = 'slow';
    title.textContent = '読み込みに時間がかかっています';
    detail.textContent = '準備を続けています。通信状況を確認してお待ちください。表示されない場合は再読み込みを試してください。';
  }, 15000);

  // This classic script is independent of the app's module graph, so an import
  // or initialization failure can still be shown in the static HTML panel.
  import('./experience.mjs?v=20261025-share').catch(function (error) { fail(error, false); });
}());
