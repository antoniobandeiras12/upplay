/**
 * UpPlay Web Analytics & Real-Time Tracking
 * - Rastreamento anônimo sem cookies de terceiros e sem fingerprinting invasivo
 * - Métrica de "Visitantes ativos no site" com verificação de visibilidade e desduplicação por abas
 * - Registro de cliques em botões de download e conexão com rota controlada /download
 */
(function() {
  'use strict';

  // 1. Gerador de ID Único Anônimo (UUIDv4 padrão)
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // 2. Identificador de Cliente (persistente no navegador para desduplicar abas)
  let clientId = '';
  try {
    clientId = localStorage.getItem('upplay_cid');
    if (!clientId) {
      clientId = 'u_' + generateUUID();
      localStorage.setItem('upplay_cid', clientId);
    }
  } catch (e) {
    clientId = 'u_temp_' + generateUUID();
  }

  // 3. Identificador de Sessão (por aba/sessão)
  let sessionId = '';
  try {
    sessionId = sessionStorage.getItem('upplay_sid');
    if (!sessionId) {
      sessionId = 's_' + generateUUID();
      sessionStorage.setItem('upplay_sid', sessionId);
    }
  } catch (e) {
    sessionId = 's_temp_' + generateUUID();
  }

  // 4. Detecção simples e discreta de tipo de dispositivo
  function getDeviceType() {
    const ua = navigator.userAgent || '';
    if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
    if (/mobile|iphone|ipod|android.*mobile|blackberry|phone/i.test(ua)) return 'mobile';
    if (/android/i.test(ua)) return 'tablet';
    return 'desktop';
  }

  // 5. Extração de Domínio de Referência e Parâmetros UTM
  function getTrafficSource() {
    let referrerDomain = '';
    try {
      if (document.referrer) {
        const parsed = new URL(document.referrer);
        if (parsed.hostname !== window.location.hostname) {
          referrerDomain = parsed.hostname.replace(/^www\./, '');
        }
      }
    } catch (e) {}

    const urlParams = new URLSearchParams(window.location.search);
    return {
      referrer_domain: referrerDomain || null,
      utm_source: urlParams.get('utm_source') || null,
      utm_medium: urlParams.get('utm_medium') || null,
      utm_campaign: urlParams.get('utm_campaign') || null
    };
  }

  // 6. Envio seguro de payload via Fetch ou SendBeacon (sem atrasar a página)
  function sendPayload(endpoint, data) {
    try {
      const payloadString = JSON.stringify(data);
      if (navigator.sendBeacon) {
        const blob = new Blob([payloadString], { type: 'application/json' });
        const success = navigator.sendBeacon(endpoint, blob);
        if (success) return;
      }
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadString,
        keepalive: true
      }).catch(function() {});
    } catch (err) {}
  }

  // 7. Sinal de Presença (Heartbeat / Ping para Visitantes Ativos Agora)
  // Regra: Página visível e atividade registrada nos últimos 60 segundos
  let lastUserActivity = Date.now();
  function recordActivity() {
    lastUserActivity = Date.now();
  }
  ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'].forEach(function(evt) {
    window.addEventListener(evt, recordActivity, { passive: true });
  });

  function sendActivePing() {
    if (document.visibilityState !== 'visible') {
      return; // Página minimizada ou em aba secundária não gera sinal ativo
    }
    const idleTime = Date.now() - lastUserActivity;
    if (idleTime > 60000) {
      return; // Inativo por mais de 60 segundos
    }

    sendPayload('/api/track/ping', {
      client_id: clientId,
      session_id: sessionId,
      page: window.location.pathname || '/',
      device_type: getDeviceType()
    });
  }

  // Envia ping inicial e a cada 20 segundos enquanto a aba estiver visível
  sendActivePing();
  const pingInterval = setInterval(sendActivePing, 20000);

  // Monitora visibilidade da aba
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      recordActivity();
      sendActivePing();
    }
  });

  // 8. Registro de Visualização de Página (Pageview)
  const traffic = getTrafficSource();
  sendPayload('/api/track/event', {
    event_type: 'pageview',
    client_id: clientId,
    session_id: sessionId,
    page_path: window.location.pathname || '/',
    device_type: getDeviceType(),
    referrer_domain: traffic.referrer_domain,
    utm_source: traffic.utm_source,
    utm_medium: traffic.utm_medium,
    utm_campaign: traffic.utm_campaign,
    dedup_token: 'pv_' + sessionId + '_' + (window.location.pathname || '/')
  });

  // 9. Rastreamento e Instrumentação dos Botões de Download
  function attachDownloadTracking() {
    const downloadBtns = document.querySelectorAll('[data-download-btn]');
    downloadBtns.forEach(function(btn) {
      const location = btn.getAttribute('data-download-btn') || 'unknown';
      const currentHref = btn.getAttribute('href') || '';

      // Adiciona parâmetros de rastreamento anônimo na URL do link
      try {
        let urlObj;
        if (window.location.protocol === 'file:') {
          urlObj = new URL(currentHref, window.location.href);
          urlObj.searchParams.set('from', location);
          urlObj.searchParams.set('cid', clientId);
          urlObj.searchParams.set('sid', sessionId);
          btn.setAttribute('href', urlObj.href);
        } else {
          urlObj = new URL(currentHref, window.location.origin);
          urlObj.searchParams.set('from', location);
          urlObj.searchParams.set('cid', clientId);
          urlObj.searchParams.set('sid', sessionId);
          btn.setAttribute('href', urlObj.pathname + urlObj.search);
        }
      } catch (e) {}

      btn.addEventListener('click', function() {
        const dedupToken = 'clk_' + clientId + '_' + location + '_' + Math.floor(Date.now() / 2500);
        sendPayload('/api/track/event', {
          event_type: 'click_download',
          client_id: clientId,
          session_id: sessionId,
          button_location: location,
          page_path: window.location.pathname || '/',
          device_type: getDeviceType(),
          referrer_domain: traffic.referrer_domain,
          utm_source: traffic.utm_source,
          utm_medium: traffic.utm_medium,
          utm_campaign: traffic.utm_campaign,
          dedup_token: dedupToken
        });

        // Dispara evento de conversão no Meta Pixel se ativo
        try {
          if (typeof window.fbq === 'function') {
            window.fbq('trackCustom', 'DownloadClick', { button_location: location });
          }
        } catch (e) {}
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachDownloadTracking);
  } else {
    attachDownloadTracking();
  }

  // Expõe cliente ID de forma segura para depuração interna se necessário
  window.__upplay_analytics = {
    getClientId: function() { return clientId; },
    getSessionId: function() { return sessionId; }
  };
})();
