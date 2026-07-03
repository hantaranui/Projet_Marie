// =============================================================================
// Marie Emailing Widget — Grist
// Liste de contacts filtrable, modèles d'email, envoi individuel/groupé via n8n.
// Garde-fous : n'envoie que Statut === "À contacter" ET Opposition === false,
// insère toujours le lien de désinscription, ne bascule Statut vers "Contacté"
// que si l'appel webhook n'a pas levé d'erreur.
// =============================================================================

var CONTACTS_TABLE = 'Contacts';
var DEPARTEMENTS_TABLE = 'Departements';
var TEMPLATES_TABLE = 'Templates';
var PARAMETRES_TABLE = 'Parametres';

var STATUT_CHOICES = ['Nouveau (à valider)', 'À contacter', 'Contacté', 'Relance 1', 'Relance 2', 'Réponse reçue', 'Opposition/refus'];
var REPONSE_CHOICES = ['Pas de réponse', 'Positif', 'Négatif', 'Mauvais contact'];

var STATUT_COLORS = {
  'Nouveau (à valider)': '#EFEFEF',
  'À contacter': '#337AB7',
  'Contacté': '#5BC0DE',
  'Relance 1': '#F0AD4E',
  'Relance 2': '#F0AD4E',
  'Réponse reçue': '#16B378',
  'Opposition/refus': '#D9534F'
};
var STATUT_TEXT_COLORS = { 'Nouveau (à valider)': '#666666' };

var STATUT_ENVOI_COLORS = { 'En attente': '#CCCCCC', 'Envoyé': '#16B378', 'Erreur': '#D9534F' };
var TYPE_EMAIL_COLORS = { officiel: '#16B378', générique: '#5BC0DE', reconstitué: '#F0AD4E', corrigé: '#5CB85C' };

var departements = [];
var departementsById = {};
var contacts = [];
var contactsById = {};
var templates = [];
var templatesById = {};
var parametres = { id: null, Webhook_Envoi_URL: '', Webhook_Desinscription_URL: '' };

var selectedIds = {}; // rowId -> true
var filters = { departement: '', statut: '' };
var currentTemplateId = null;
var currentTab = 'contacts';

// =============================================================================
// UTILS
// =============================================================================

function isInsideGrist() {
  try { return window.self !== window.top; } catch (e) { return true; }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function showToast(msg, type, duration) {
  var container = document.getElementById('toast-container');
  var el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'info');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(function () { el.remove(); }, duration || 4500);
}

function tableToRows(tableData) {
  var ids = (tableData && tableData.id) || [];
  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    var row = { id: ids[i] };
    Object.keys(tableData).forEach(function (col) {
      if (col === 'id') return;
      row[col] = tableData[col][i];
    });
    rows.push(row);
  }
  return rows;
}

function byId(rows) {
  var map = {};
  rows.forEach(function (r) { map[r.id] = r; });
  return map;
}

function dateToGristValue(dateObjOrIso) {
  var d = (dateObjOrIso instanceof Date) ? dateObjOrIso : new Date(dateObjOrIso + 'T00:00:00Z');
  return Math.floor(d.getTime() / 1000);
}

function todayGristValue() {
  var now = new Date();
  var iso = now.toISOString().slice(0, 10);
  return dateToGristValue(iso);
}

function fillTemplate(str, contact) {
  if (!str) return '';
  return str.replace(/\{(\w+)\}/g, function (match, key) {
    var val = contact ? contact[key] : undefined;
    return (val === undefined || val === null) ? '' : String(val);
  });
}

function buildEmailForContact(template, contact) {
  var subject = fillTemplate(template.Sujet, contact);
  var body = fillTemplate(template.Corps, contact);
  var link = contact.Lien_Desinscription || '';
  var linkMissing = !link;
  if (link && body.indexOf(link) === -1) {
    body += '\n\n---\nPour ne plus recevoir nos communications : ' + link;
  }
  return { subject: subject, body: body, linkMissing: linkMissing };
}

// =============================================================================
// DATA LOADING
// =============================================================================

async function loadAllData() {
  var depData = await grist.docApi.fetchTable(DEPARTEMENTS_TABLE);
  departements = tableToRows(depData);
  departementsById = byId(departements);

  var contactData = await grist.docApi.fetchTable(CONTACTS_TABLE);
  contacts = tableToRows(contactData);
  contactsById = byId(contacts);

  var templateData = await grist.docApi.fetchTable(TEMPLATES_TABLE);
  templates = tableToRows(templateData).filter(function (t) { return t.Actif !== false; });
  templatesById = byId(templates);
  if (!currentTemplateId && templates.length > 0) currentTemplateId = templates[0].id;

  var paramData = await grist.docApi.fetchTable(PARAMETRES_TABLE);
  var paramRows = tableToRows(paramData);
  parametres = paramRows[0] || { id: null, Webhook_Envoi_URL: '', Webhook_Desinscription_URL: '' };
}

// =============================================================================
// TABS
// =============================================================================

function switchTab(tab) {
  currentTab = tab;
  ['contacts', 'templates', 'settings'].forEach(function (t) {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  renderCurrentTab();
}

function renderCurrentTab() {
  if (currentTab === 'contacts') renderContactsTab();
  else if (currentTab === 'templates') renderTemplatesTab();
  else if (currentTab === 'settings') renderSettingsTab();
}

// =============================================================================
// CONTACTS TAB
// =============================================================================

function getFilteredContacts() {
  return contacts.filter(function (c) {
    if (filters.departement && String(c.Departement) !== String(filters.departement)) return false;
    if (filters.statut && c.Statut !== filters.statut) return false;
    return true;
  });
}

function badge(text, bg, color) {
  return '<span class="badge" style="background:' + (bg || '#EEE') + ';color:' + (color || '#000') + '">' + esc(text || '—') + '</span>';
}

function scoreColor(score) {
  if (!score) return '#EEE';
  if (score.indexOf('100') === 0) return '#16B378';
  if (score.indexOf('90') === 0) return '#5CB85C';
  if (score.indexOf('80') === 0) return '#8BC34A';
  if (score.indexOf('60') === 0) return '#F0AD4E';
  if (score.indexOf('40') === 0) return '#E67E22';
  return '#D9534F';
}

function renderContactsTab() {
  var container = document.getElementById('tab-contacts');
  var filtered = getFilteredContacts();
  var selectedCount = Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; }).length;

  var html = '';

  // --- Toolbar filtres ---
  html += '<div class="toolbar">';
  html += '<select id="filter-departement" onchange="onFilterChange()"><option value="">Tous les départements</option>';
  departements.forEach(function (d) {
    html += '<option value="' + d.id + '"' + (String(filters.departement) === String(d.id) ? ' selected' : '') + '>' + esc(d.Nom) + '</option>';
  });
  html += '</select>';

  html += '<select id="filter-statut" onchange="onFilterChange()"><option value="">Tous les statuts</option>';
  STATUT_CHOICES.forEach(function (s) {
    html += '<option value="' + esc(s) + '"' + (filters.statut === s ? ' selected' : '') + '>' + esc(s) + '</option>';
  });
  html += '</select>';

  html += '<span class="hint">' + filtered.length + ' contact(s)</span>';
  html += '<div class="spacer"></div>';
  html += '</div>';

  // --- Barre de sélection / actions groupées ---
  html += '<div class="selection-bar">';
  html += '<strong>' + selectedCount + ' sélectionné(s)</strong>';
  html += '<button class="btn btn-sm" onclick="validateSelection()" ' + (selectedCount ? '' : 'disabled') + '>Valider → À contacter</button>';
  html += '<button class="btn btn-sm btn-danger" onclick="markOppositionSelection()" ' + (selectedCount ? '' : 'disabled') + '>Marquer opposition</button>';
  html += '<div class="spacer"></div>';
  html += '<select id="bulk-template-select">';
  templates.forEach(function (t) {
    html += '<option value="' + t.id + '"' + (t.id === currentTemplateId ? ' selected' : '') + '>' + esc(t.Nom) + '</option>';
  });
  html += '</select>';
  html += '<button class="btn btn-primary btn-sm" onclick="openSendModal()" ' + (selectedCount ? '' : 'disabled') + '>✉️ Envoyer à la sélection</button>';
  html += '</div>';

  // --- Table ---
  html += '<div style="overflow:auto; max-height: 60vh;"><table class="contacts-table"><thead><tr>';
  html += '<th><input type="checkbox" id="select-all" onchange="toggleSelectAllVisible(this.checked)"></th>';
  html += '<th>Collectivité</th><th>Structure</th><th>Prénom</th><th>Nom</th><th>Titre</th><th>Email à utiliser</th>';
  html += '<th>Confiance</th><th>Type</th><th>Statut</th><th>Réponse</th><th>Envoi</th><th></th>';
  html += '</tr></thead><tbody>';

  filtered.forEach(function (c) {
    var checked = !!selectedIds[c.id];
    html += '<tr>';
    html += '<td><input type="checkbox" class="row-select" data-id="' + c.id + '" ' + (checked ? 'checked' : '') + ' onchange="toggleRowSelect(' + c.id + ', this.checked)"></td>';
    html += '<td>' + esc(c.Collectivite) + '</td>';
    html += '<td>' + esc(c.Structure) + '</td>';
    html += '<td>' + esc(c.Prenom) + '</td>';
    html += '<td>' + esc(c.Nom) + '</td>';
    html += '<td title="' + esc(c.Titre) + '">' + esc((c.Titre || '').slice(0, 28)) + ((c.Titre || '').length > 28 ? '…' : '') + '</td>';
    html += '<td class="email-cell">' + esc(c.Email_a_utiliser) + '</td>';
    html += '<td>' + badge(c.Score_confiance ? c.Score_confiance.split(' - ')[0] + '%' : '—', scoreColor(c.Score_confiance)) + '</td>';
    html += '<td>' + badge(c.Type_email, TYPE_EMAIL_COLORS[c.Type_email]) + '</td>';
    html += '<td>' + selectMini(c.id, 'Statut', STATUT_CHOICES, c.Statut) + '</td>';
    html += '<td>' + selectMini(c.id, 'Reponse', REPONSE_CHOICES, c.Reponse) + '</td>';
    html += '<td>' + badge(c.Statut_envoi, STATUT_ENVOI_COLORS[c.Statut_envoi]) + (c.Erreur_envoi ? ' <span title="' + esc(c.Erreur_envoi) + '">⚠️</span>' : '') + '</td>';
    html += '<td><button class="btn btn-sm" onclick="openSendModal(' + c.id + ')">✉️</button></td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function selectMini(rowId, field, choices, current) {
  var html = '<select class="mini-select" onchange="updateContactField(' + rowId + ', \'' + field + '\', this.value)">';
  choices.forEach(function (choice) {
    html += '<option value="' + esc(choice) + '"' + (choice === current ? ' selected' : '') + '>' + esc(choice) + '</option>';
  });
  html += '</select>';
  return html;
}

function onFilterChange() {
  filters.departement = document.getElementById('filter-departement').value;
  filters.statut = document.getElementById('filter-statut').value;
  renderContactsTab();
}

function toggleRowSelect(id, checked) {
  selectedIds[id] = checked;
  renderContactsTab();
}

function toggleSelectAllVisible(checked) {
  getFilteredContacts().forEach(function (c) { selectedIds[c.id] = checked; });
  renderContactsTab();
}

async function updateContactField(rowId, field, value) {
  try {
    var fields = {};
    fields[field] = value;
    await grist.docApi.applyUserActions([['UpdateRecord', CONTACTS_TABLE, rowId, fields]]);
    contactsById[rowId][field] = value;
    showToast('Mis à jour.', 'success', 1800);
  } catch (e) {
    showToast('Erreur de mise à jour : ' + e.message, 'error');
  }
}

async function validateSelection() {
  var ids = Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; }).map(Number);
  var toUpdate = ids.filter(function (id) { return contactsById[id] && contactsById[id].Statut === 'Nouveau (à valider)'; });
  if (toUpdate.length === 0) {
    showToast('Aucun contact sélectionné n\'est au statut "Nouveau (à valider)".', 'info');
    return;
  }
  await grist.docApi.applyUserActions([
    ['BulkUpdateRecord', CONTACTS_TABLE, toUpdate, { Statut: toUpdate.map(function () { return 'À contacter'; }) }]
  ]);
  toUpdate.forEach(function (id) { contactsById[id].Statut = 'À contacter'; });
  showToast(toUpdate.length + ' contact(s) passé(s) à "À contacter".', 'success');
  renderContactsTab();
}

async function markOppositionSelection() {
  var ids = Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; }).map(Number);
  if (ids.length === 0) return;
  if (!confirm(ids.length + ' contact(s) seront marqués en opposition et ne seront plus jamais proposés à l\'envoi. Confirmer ?')) return;
  await grist.docApi.applyUserActions([
    ['BulkUpdateRecord', CONTACTS_TABLE, ids, {
      Opposition: ids.map(function () { return true; }),
      Statut: ids.map(function () { return 'Opposition/refus'; })
    }]
  ]);
  ids.forEach(function (id) { contactsById[id].Opposition = true; contactsById[id].Statut = 'Opposition/refus'; });
  showToast(ids.length + ' contact(s) marqué(s) en opposition.', 'success');
  renderContactsTab();
}

// =============================================================================
// SEND MODAL (individuel ou groupé)
// =============================================================================

function openSendModal(singleContactId) {
  var ids = singleContactId ? [singleContactId] : Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; }).map(Number);
  if (ids.length === 0) { showToast('Aucun contact sélectionné.', 'error'); return; }

  var eligible = ids.filter(function (id) { var c = contactsById[id]; return c && c.Statut === 'À contacter' && !c.Opposition; });
  var skipped = ids.filter(function (id) { return eligible.indexOf(id) === -1; });

  var selectedTemplateId = currentTemplateId || (templates[0] && templates[0].id);
  var sample = eligible.length ? contactsById[eligible[0]] : null;
  var isSingle = ids.length === 1 && eligible.length === 1;
  window._sendMode = 'template';

  var modalContainer = document.getElementById('modal-container');
  var html = '<div class="modal-overlay" onclick="if(event.target===this) closeModal()">';
  html += '<div class="modal">';
  html += '<div class="modal-header"><h2>Envoyer (' + eligible.length + '/' + ids.length + ' éligible(s))</h2><button class="modal-close" onclick="closeModal()">✕</button></div>';
  html += '<div class="modal-body">';

  if (skipped.length > 0) {
    html += '<div class="warning-box">' + skipped.length + ' contact(s) ignoré(s) : statut différent de "À contacter" ou opposition exprimée. Utilisez "Valider → À contacter" d\'abord si besoin.</div>';
  }
  if (eligible.length === 0) {
    html += '<div class="error-box">Aucun contact éligible. Rien à envoyer.</div>';
  } else if (!parametres.Webhook_Envoi_URL) {
    if (eligible.length > 1) {
      html += '<div class="error-box">Aucun webhook d\'envoi configuré (onglet Paramètres) — l\'envoi groupé nécessite un webhook. Pour un envoi ponctuel, faites-le contact par contact (bouton ✉️ sur une seule ligne) : un brouillon s\'ouvrira dans votre messagerie.</div>';
    } else {
      html += '<div class="warning-box">Aucun webhook configuré — un brouillon s\'ouvrira dans votre messagerie (mailto), l\'envoi ne sera pas automatique.</div>';
    }
  }

  if (isSingle) {
    html += '<div class="toolbar" style="margin-bottom:10px;">';
    html += '<button type="button" class="btn btn-sm btn-primary" id="mode-btn-template" onclick="setSendMode(\'template\')">📋 Modèle</button>';
    html += '<button type="button" class="btn btn-sm" id="mode-btn-custom" onclick="setSendMode(\'custom\')">✏️ Email personnalisé</button>';
    html += '</div>';
  }

  html += '<div id="send-template-block">';
  html += '<div class="field-label">Modèle</div>';
  html += '<select id="send-template-select" onchange="refreshSendPreview()">';
  templates.forEach(function (t) {
    html += '<option value="' + t.id + '"' + (t.id === selectedTemplateId ? ' selected' : '') + '>' + esc(t.Nom) + '</option>';
  });
  html += '</select>';
  html += '<div id="send-preview"></div>';
  html += '</div>';

  html += '<div id="send-custom-block" class="hidden">';
  html += '<div class="field-label">Sujet</div>';
  html += '<input type="text" id="custom-sujet" placeholder="Objet de l\'email">';
  html += '<div class="field-label">Message</div>';
  html += '<textarea id="custom-corps" style="width:100%; min-height:220px; padding:8px 10px; border:1px solid var(--color-border); border-radius:8px;" placeholder="Écrivez votre message pour ' + (sample ? esc(sample.Prenom + ' ' + sample.Nom) : 'ce contact') + '"></textarea>';
  html += '<div id="custom-warning"></div>';
  html += '<div class="variables-hint">Vous pouvez aussi utiliser <code>{Prenom}</code>, <code>{Nom}</code>, <code>{Titre}</code>, <code>{Collectivite}</code> si besoin — le lien de désinscription est ajouté automatiquement en pied de message s\'il est absent.</div>';
  html += '</div>';

  html += '</div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn" onclick="closeModal()">Annuler</button>';
  html += '<button class="btn btn-primary" id="send-confirm-btn" onclick="confirmSend(' + JSON.stringify(eligible) + ')" ' + (eligible.length === 0 ? 'disabled' : '') + '>' +
    (eligible.length > 1 ? 'Envoyer à ' + eligible.length + ' contact(s)' : 'Envoyer') + '</button>';
  html += '</div></div></div>';

  modalContainer.innerHTML = html;
  window._sendModalSample = sample;
  refreshSendPreview();
}

function setSendMode(mode) {
  window._sendMode = mode;
  document.getElementById('send-template-block').classList.toggle('hidden', mode !== 'template');
  document.getElementById('send-custom-block').classList.toggle('hidden', mode !== 'custom');
  var tBtn = document.getElementById('mode-btn-template');
  var cBtn = document.getElementById('mode-btn-custom');
  if (tBtn) tBtn.classList.toggle('btn-primary', mode === 'template');
  if (cBtn) cBtn.classList.toggle('btn-primary', mode === 'custom');
  if (mode === 'custom') refreshCustomWarning();
}

function refreshCustomWarning() {
  var warn = document.getElementById('custom-warning');
  if (!warn) return;
  var sample = window._sendModalSample;
  if (sample && !sample.Lien_Desinscription) {
    warn.innerHTML = '<div class="warning-box">Ce contact n\'a pas encore de lien de désinscription (webhook de désinscription non configuré dans Paramètres) — l\'email partira sans, à corriger avant tout envoi réel.</div>';
  } else {
    warn.innerHTML = '';
  }
}

function refreshSendPreview() {
  if (window._sendMode === 'custom') return;
  var select = document.getElementById('send-template-select');
  if (!select) return;
  var templateId = Number(select.value);
  currentTemplateId = templateId;
  var template = templatesById[templateId];
  var preview = document.getElementById('send-preview');
  var sample = window._sendModalSample;

  if (!template) { preview.innerHTML = ''; return; }
  if (!sample) {
    preview.innerHTML = '<p class="hint">Aucun contact éligible à prévisualiser.</p>';
    return;
  }
  var built = buildEmailForContact(template, sample);
  var html = '<div class="field-label">Aperçu — ' + esc(sample.Prenom + ' ' + sample.Nom) + '</div>';
  html += '<p><strong>Objet :</strong> ' + esc(built.subject) + '</p>';
  html += '<pre style="white-space:pre-wrap; font-family:inherit; background:#F7F8FC; padding:10px; border-radius:8px; margin-top:6px;">' + esc(built.body) + '</pre>';
  if (built.linkMissing) {
    html += '<div class="warning-box">Ce contact n\'a pas encore de lien de désinscription (webhook de désinscription non configuré dans Paramètres) — l\'email partira sans, à corriger avant tout envoi réel.</div>';
  }
  preview.innerHTML = html;
}

function closeModal() {
  document.getElementById('modal-container').innerHTML = '';
}

async function confirmSend(eligibleIds) {
  var template;
  if (window._sendMode === 'custom' && eligibleIds.length === 1) {
    var customCorps = document.getElementById('custom-corps').value;
    if (!customCorps.trim()) { showToast('Le message est vide.', 'error'); return; }
    template = { Sujet: document.getElementById('custom-sujet').value, Corps: customCorps };
  } else {
    var templateId = Number(document.getElementById('send-template-select').value);
    template = templatesById[templateId];
    if (!template) { showToast('Modèle introuvable.', 'error'); return; }
  }

  if (eligibleIds.length === 1 && !parametres.Webhook_Envoi_URL) {
    // Fallback mailto pour un envoi ponctuel
    var c = contactsById[eligibleIds[0]];
    var built = buildEmailForContact(template, c);
    var mailto = 'mailto:' + encodeURIComponent(c.Email_a_utiliser) + '?subject=' + encodeURIComponent(built.subject) + '&body=' + encodeURIComponent(built.body);
    window.open(mailto, '_blank');
    showToast('Brouillon ouvert dans votre messagerie — pensez à mettre à jour le statut une fois l\'email réellement envoyé.', 'info', 6000);
    closeModal();
    return;
  }

  if (!parametres.Webhook_Envoi_URL) {
    showToast('Configurez d\'abord le webhook d\'envoi dans Paramètres.', 'error');
    return;
  }

  var recipients = eligibleIds.map(function (id) {
    var c = contactsById[id];
    var built = buildEmailForContact(template, c);
    return { rowId: id, email: c.Email_a_utiliser, contact: (c.Prenom + ' ' + c.Nom).trim(), collectivite: c.Collectivite, subject: built.subject, body: built.body };
  });

  var payload = eligibleIds.length > 1
    ? { type: 'bulk_email', recipients: recipients.map(function (r) { return { email: r.email, contact: r.contact, collectivite: r.collectivite, subject: r.subject, body: r.body }; }) }
    : { type: 'email', email: recipients[0].email, contact: recipients[0].contact, collectivite: recipients[0].collectivite, subject: recipients[0].subject, body: recipients[0].body };

  try {
    await fetch(parametres.Webhook_Envoi_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var ids = recipients.map(function (r) { return r.rowId; });
    var today = todayGristValue();
    await grist.docApi.applyUserActions([
      ['BulkUpdateRecord', CONTACTS_TABLE, ids, {
        Statut_envoi: ids.map(function () { return 'Envoyé'; }),
        Statut: ids.map(function () { return 'Contacté'; }),
        Date_Envoi: ids.map(function () { return today; }),
        Erreur_envoi: ids.map(function () { return ''; })
      }]
    ]);
    showToast(ids.length + ' email(s) envoyé(s) via le webhook.', 'success');
  } catch (e) {
    var idsErr = recipients.map(function (r) { return r.rowId; });
    await grist.docApi.applyUserActions([
      ['BulkUpdateRecord', CONTACTS_TABLE, idsErr, {
        Statut_envoi: idsErr.map(function () { return 'Erreur'; }),
        Erreur_envoi: idsErr.map(function () { return String(e.message || e); })
      }]
    ]);
    showToast('Erreur lors de l\'appel du webhook : ' + e.message, 'error');
  }

  closeModal();
  await loadAllData();
  renderCurrentTab();
}

// =============================================================================
// TEMPLATES TAB
// =============================================================================

function renderTemplatesTab() {
  var container = document.getElementById('tab-templates');
  if (!currentTemplateId && templates.length) currentTemplateId = templates[0].id;
  var current = templatesById[currentTemplateId];

  var html = '<div class="toolbar"><button class="btn btn-primary btn-sm" onclick="createTemplate()">+ Nouveau modèle</button></div>';
  html += '<div class="templates-grid">';

  html += '<div class="template-list">';
  templates.forEach(function (t) {
    html += '<div class="template-item ' + (t.id === currentTemplateId ? 'active' : '') + '" onclick="selectTemplate(' + t.id + ')">';
    html += '<span>' + esc(t.Nom || '(sans nom)') + '</span>';
    html += '</div>';
  });
  if (templates.length === 0) html += '<p class="hint">Aucun modèle actif.</p>';
  html += '</div>';

  html += '<div class="template-editor">';
  if (current) {
    html += '<div class="field-label">Nom du modèle</div>';
    html += '<input type="text" id="tpl-nom" value="' + esc(current.Nom) + '">';
    html += '<div class="field-label">Sujet</div>';
    html += '<input type="text" id="tpl-sujet" value="' + esc(current.Sujet) + '">';
    html += '<div class="field-label">Corps</div>';
    html += '<textarea id="tpl-corps">' + esc(current.Corps) + '</textarea>';
    html += '<div class="variables-hint">Variables disponibles : <code>{Prenom}</code> <code>{Nom}</code> <code>{Titre}</code> <code>{Structure}</code> <code>{Collectivite}</code> <code>{Email_a_utiliser}</code> <code>{Lien_Desinscription}</code>. Le lien de désinscription est ajouté automatiquement en pied de message s\'il est absent.</div>';
    html += '<div style="margin-top:14px; display:flex; gap:8px;">';
    html += '<button class="btn btn-primary" onclick="saveTemplate(' + current.id + ')">Enregistrer</button>';
    html += '<button class="btn btn-danger" onclick="deleteTemplate(' + current.id + ')">Supprimer</button>';
    html += '</div>';
  } else {
    html += '<p class="hint">Sélectionnez ou créez un modèle.</p>';
  }
  html += '</div></div>';

  container.innerHTML = html;
}

function selectTemplate(id) {
  currentTemplateId = id;
  renderTemplatesTab();
}

async function createTemplate() {
  var result = await grist.docApi.applyUserActions([
    ['AddRecord', TEMPLATES_TABLE, null, { Nom: 'Nouveau modèle', Sujet: '', Corps: '', Actif: true }]
  ]);
  await loadAllData();
  currentTemplateId = result.retValues[0];
  renderTemplatesTab();
}

async function saveTemplate(id) {
  var fields = {
    Nom: document.getElementById('tpl-nom').value,
    Sujet: document.getElementById('tpl-sujet').value,
    Corps: document.getElementById('tpl-corps').value
  };
  await grist.docApi.applyUserActions([['UpdateRecord', TEMPLATES_TABLE, id, fields]]);
  await loadAllData();
  showToast('Modèle enregistré.', 'success');
  renderTemplatesTab();
}

async function deleteTemplate(id) {
  if (!confirm('Supprimer ce modèle ?')) return;
  await grist.docApi.applyUserActions([['RemoveRecord', TEMPLATES_TABLE, id]]);
  currentTemplateId = null;
  await loadAllData();
  renderTemplatesTab();
}

// =============================================================================
// SETTINGS TAB
// =============================================================================

function renderSettingsTab() {
  var container = document.getElementById('tab-settings');
  var html = '<div class="settings-form">';
  html += '<div class="field-label">URL webhook n8n — envoi des emails</div>';
  html += '<input type="text" id="set-webhook-envoi" value="' + esc(parametres.Webhook_Envoi_URL || '') + '" placeholder="https://...">';
  html += '<div class="hint">Utilisé par le bouton "Envoyer". Sans cette URL, seul un envoi individuel via mailto: est possible.</div>';

  html += '<div class="field-label">URL webhook n8n — désinscription</div>';
  html += '<input type="text" id="set-webhook-desinscription" value="' + esc(parametres.Webhook_Desinscription_URL || '') + '" placeholder="https://...">';
  html += '<div class="hint">Génère le lien unique par contact (colonne Lien_Desinscription) inséré dans chaque email.</div>';

  html += '<div style="margin-top:16px;"><button class="btn btn-primary" onclick="saveSettings()">Enregistrer</button></div>';
  html += '</div>';
  container.innerHTML = html;
}

async function saveSettings() {
  var fields = {
    Webhook_Envoi_URL: document.getElementById('set-webhook-envoi').value.trim(),
    Webhook_Desinscription_URL: document.getElementById('set-webhook-desinscription').value.trim()
  };
  if (parametres.id) {
    await grist.docApi.applyUserActions([['UpdateRecord', PARAMETRES_TABLE, parametres.id, fields]]);
  } else {
    await grist.docApi.applyUserActions([['AddRecord', PARAMETRES_TABLE, null, fields]]);
  }
  await loadAllData();
  showToast('Paramètres enregistrés.', 'success');
  renderSettingsTab();
}

// =============================================================================
// INIT
// =============================================================================

if (!isInsideGrist()) {
  document.getElementById('not-in-grist').classList.remove('hidden');
  document.getElementById('main-content').classList.add('hidden');
} else {
  (async function () {
    await grist.ready({ requiredAccess: 'full' });
    await loadAllData();
    renderCurrentTab();

    if (typeof grist.onRecords === 'function') {
      var _liveReloadTimer = null;
      grist.onRecords(function () {
        if (_liveReloadTimer) clearTimeout(_liveReloadTimer);
        _liveReloadTimer = setTimeout(function () {
          var modal = document.getElementById('modal-container');
          if (modal && modal.innerHTML.trim() !== '') return;
          loadAllData().then(renderCurrentTab);
        }, 600);
      });
    }
  })();
}
