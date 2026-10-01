// ShoMate 설정 페이지 — chrome.storage.local 에만 저장한다. 인라인 스크립트 금지(MV3 CSP)라 분리.
(function () {
  'use strict';

  const KEYS = ['geminiApiKey', 'backendUrl', 'naverClientId', 'naverClientSecret'];
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');

  function showStatus(kind, text) {
    statusEl.className = kind;
    statusEl.textContent = text;
  }

  function load() {
    chrome.storage.local.get(KEYS, (items) => {
      if (chrome.runtime.lastError) {
        showStatus('err', '설정을 불러오지 못했습니다: ' + chrome.runtime.lastError.message);
        return;
      }
      for (const k of KEYS) $(k).value = (items && items[k]) || '';
    });
  }

  function describe(st) {
    if (!st || st.error) return { kind: 'err', text: '상태를 확인할 수 없습니다' + (st && st.error ? ': ' + st.error : '') + '.' };
    const naver = st.hasNaver ? ' 네이버 검색 API: 설정됨.' : ' 네이버 검색 API: 미설정(네이버 쇼핑 가격 비교 비활성).';
    if (st.path === 'backend') {
      return { kind: 'ok', text: `AI 호출 경로: 백엔드 서버(${st.backendUrl}) — 온라인.` + (st.hasUserKey ? ' 본인 Gemini 키도 저장돼 있어 서버 장애 시 그 키로 넘어갑니다.' : '') + naver };
    }
    if (st.path === 'userKey') {
      const why = st.backendUrl ? `백엔드 서버(${st.backendUrl})에 연결할 수 없어 ` : '';
      return { kind: 'ok', text: `AI 호출 경로: ${why}본인 Gemini API 키로 직접 호출합니다.` + naver };
    }
    const why = st.backendUrl ? `백엔드 서버(${st.backendUrl})에 연결할 수 없고 ` : '백엔드 서버 URL이 없고 ';
    return { kind: 'warn', text: `AI를 사용할 수 없습니다: ${why}Gemini API 키도 없습니다. 위에서 키를 입력하거나 백엔드 URL을 지정하세요.` + naver };
  }

  function checkStatus(prefix) {
    chrome.runtime.sendMessage({ type: 'aiStatus' }, (res) => {
      if (chrome.runtime.lastError) {
        showStatus('err', (prefix || '') + '확장 프로그램에 연결하지 못했습니다: ' + chrome.runtime.lastError.message);
        return;
      }
      const d = describe(res);
      showStatus(d.kind, (prefix || '') + d.text);
    });
  }

  function save() {
    const data = {};
    for (const k of KEYS) data[k] = ($(k).value || '').trim();
    data.backendUrl = data.backendUrl.replace(/\/+$/, '');
    if (data.backendUrl && !/^https?:\/\//i.test(data.backendUrl)) {
      showStatus('err', '백엔드 서버 URL은 http:// 또는 https:// 로 시작해야 합니다.');
      return;
    }
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        showStatus('err', '저장 실패: ' + chrome.runtime.lastError.message);
        return;
      }
      $('backendUrl').value = data.backendUrl;
      showStatus('ok', '저장했습니다. 연결 상태를 확인하는 중…');
      checkStatus('저장했습니다. ');
    });
  }

  $('save').addEventListener('click', save);
  $('check').addEventListener('click', () => { showStatus('ok', '확인 중…'); checkStatus(''); });
  load();
})();
