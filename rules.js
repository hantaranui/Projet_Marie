(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EmailingRules = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function normalize(value) {
    return text(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value));
  }

  function validHttpsUrl(value) {
    try {
      var url = new URL(text(value));
      return url.protocol === 'https:' && Boolean(url.hostname);
    } catch (error) {
      return false;
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function markdownLinksToSafeHtml(value) {
    var source = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
    var linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi;
    var html = '';
    var lastIndex = 0;
    var match;

    while ((match = linkPattern.exec(source)) !== null) {
      html += escapeHtml(source.slice(lastIndex, match.index));
      html += '<a href="' + escapeHtml(match[2]) + '" target="_blank" rel="noopener noreferrer" style="color:#137B70;text-decoration:underline;">' + escapeHtml(match[1]) + '</a>';
      lastIndex = linkPattern.lastIndex;
    }

    html += escapeHtml(source.slice(lastIndex));
    return html.replace(/\n/g, '<br>');
  }

  function emailBodyWithUnsubscribe(body, unsubscribeUrl) {
    var content = String(body == null ? '' : body).trim();
    var url = text(unsubscribeUrl);
    if (url) {
      var markdownLink = '[Se désinscrire](' + url + ')';
      if (content.indexOf('](' + url + ')') === -1 && content.indexOf(url) !== -1) {
        content = content.split(url).join(markdownLink);
      } else if (content.indexOf(url) === -1) {
        content += '\n\n---\n' + markdownLink;
      }
    }
    return content;
  }

  function emailBodyToSafeHtml(body, unsubscribeUrl) {
    var content = emailBodyWithUnsubscribe(body, unsubscribeUrl);
    return '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#20252B;">' + markdownLinksToSafeHtml(content) + '</div>';
  }

  function blockingReasons(contact) {
    var reasons = preparationBlockingReasons(contact);
    if (!text(contact.Sujet_final)) reasons.push('Sujet manquant');
    if (!text(contact.Corps_final)) reasons.push('Message manquant');
    return reasons;
  }

  function preparationBlockingReasons(contact) {
    var reasons = [];
    var contactStatus = normalize(contact.Statut);
    if (contactStatus !== 'nouveau (a valider)' && contactStatus !== 'a contacter') reasons.push('Statut incompatible avec un premier envoi');
    if (contact.Archive) reasons.push('Contact archivé');
    if (!validEmail(contact.Email_a_utiliser)) reasons.push(text(contact.Email_a_utiliser) ? 'Format d’adresse email invalide' : 'Email manquant');
    if (contact.Opposition) reasons.push('Opposition exprimée');
    if (text(contact.Motif_ne_pas_contacter)) reasons.push('Motif de ne pas contacter renseigné');
    if (contact.Civilite_a_verifier) reasons.push('Civilité à vérifier');
    if (!text(contact.Lien_Desinscription)) reasons.push('Lien de désinscription manquant');
    return reasons;
  }

  function queueState(contact) {
    var status = normalize(contact.Statut_envoi);
    if (status === 'en cours') return 'processing';
    if (status === 'envoye') return 'sent';
    if (status === 'erreur') return 'error';
    if (contact.Statut !== 'À contacter') return 'draft';
    if (blockingReasons(contact).length) return 'blocked';
    if (normalize(contact.Mode_envoi) === 'programme') return 'scheduled';
    return 'ready';
  }

  function canPrepare(contact) {
    var state = queueState(contact);
    return state !== 'processing' && state !== 'sent' && preparationBlockingReasons(contact).length === 0;
  }

  function initialPreparationBlockingReasons(contact, sends) {
    var reasons = preparationBlockingReasons(contact);
    var history = (sends || []).filter(function (send) { return Number(send.Contact) === Number(contact.id); });
    var active = history.some(function (send) {
      var status = normalize(send.Statut_envoi);
      return status === 'en attente' || status === 'en cours';
    });
    var alreadySent = history.some(function (send) {
      return normalize(send.Type_envoi) === 'premier envoi' && normalize(send.Statut_envoi) === 'envoye';
    });
    if (active) reasons.push('Un envoi est déjà prévu');
    if (alreadySent) reasons.push('Premier envoi déjà effectué');
    return reasons;
  }

  function canPrepareInitial(contact, sends) {
    var state = queueState(contact);
    return state !== 'processing' && state !== 'sent' && initialPreparationBlockingReasons(contact, sends).length === 0;
  }

  function summarize(contacts) {
    return contacts.reduce(function (acc, contact) {
      var state = queueState(contact);
      acc.total += 1;
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, { total: 0, draft: 0, blocked: 0, ready: 0, scheduled: 0, processing: 0, sent: 0, error: 0 });
  }

  function relaunchEligibility(contact, sends, settings, nowSeconds) {
    var config = settings || {};
    var now = Number(nowSeconds) || Math.floor(Date.now() / 1000);
    if (contact.Archive) return { eligible: false, reason: 'Contact archivé' };
    if (!config.Relances_activees) return { eligible: false, reason: 'Relances désactivées' };
    if (contact.Opposition || text(contact.Motif_ne_pas_contacter)) return { eligible: false, reason: 'Opposition ou exclusion' };
    if (normalize(contact.Reponse) !== 'pas de reponse') return { eligible: false, reason: 'Une réponse est enregistrée' };
    var sendStatus = normalize(contact.Statut_envoi);
    if (contact.Date_rejet || sendStatus === 'erreur' || sendStatus === 'non distribue') return { eligible: false, reason: 'Adresse à vérifier' };

    var history = (sends || []).filter(function (send) { return Number(send.Contact) === Number(contact.id); });
    var active = history.some(function (send) {
      var status = normalize(send.Statut_envoi);
      return status === 'en attente' || status === 'en cours';
    });
    if (active) return { eligible: false, reason: 'Un envoi est déjà prévu' };

    var successful = history.filter(function (send) { return normalize(send.Statut_envoi) === 'envoye' && Number(send.Date_envoi); });
    var relaunchCount = successful.filter(function (send) { return normalize(send.Type_envoi).indexOf('relance') === 0; }).length;
    var lastDate = successful.reduce(function (latest, send) { return Math.max(latest, Number(send.Date_envoi) || 0); }, 0);

    // Compatibilité avec les envois réalisés avant la création de la table Envois.
    if (!lastDate && normalize(contact.Statut_envoi) === 'envoye' && Number(contact.Date_Envoi)) lastDate = Number(contact.Date_Envoi);
    if (!lastDate) return { eligible: false, reason: 'Aucun envoi réussi' };

    var max = Math.max(0, Number(config.Nombre_max_relances) || 0);
    if (relaunchCount >= max) return { eligible: false, reason: 'Nombre maximal de relances atteint' };
    var nextNumber = relaunchCount + 1;
    var delay = nextNumber === 1 ? Number(config.Delai_relance_1_jours) : Number(config.Delai_relance_2_jours);
    delay = Math.max(0, delay || 0);
    var eligibleAt = lastDate + delay * 86400;
    return {
      eligible: now >= eligibleAt,
      reason: now >= eligibleAt ? '' : 'Délai non atteint',
      nextType: 'Relance ' + nextNumber,
      eligibleAt: eligibleAt,
      daysRemaining: Math.max(0, Math.ceil((eligibleAt - now) / 86400)),
      relaunchCount: relaunchCount
    };
  }

  return {
    text: text,
    normalize: normalize,
    validEmail: validEmail,
    validHttpsUrl: validHttpsUrl,
    escapeHtml: escapeHtml,
    markdownLinksToSafeHtml: markdownLinksToSafeHtml,
    emailBodyWithUnsubscribe: emailBodyWithUnsubscribe,
    emailBodyToSafeHtml: emailBodyToSafeHtml,
    blockingReasons: blockingReasons,
    preparationBlockingReasons: preparationBlockingReasons,
    queueState: queueState,
    canPrepare: canPrepare,
    initialPreparationBlockingReasons: initialPreparationBlockingReasons,
    canPrepareInitial: canPrepareInitial,
    summarize: summarize,
    relaunchEligibility: relaunchEligibility
  };
}));
