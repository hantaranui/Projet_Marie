// =============================================================================
// Emailing Prospection — Grist
// Liste de contacts filtrable, modèles d'email et préparation des envois pour n8n.
// Le widget écrit les demandes dans Grist ; le workflow n8n publié les traite ensuite.
// =============================================================================

var CONTACTS_TABLE = 'Contacts';
var DEPARTEMENTS_TABLE = 'Departements';
var TEMPLATES_TABLE = 'Templates';
var PARAMETRES_TABLE = 'Parametres';
var ENVOIS_TABLE = 'Envois';

var STATUT_CHOICES = ['Nouveau (à valider)', 'À contacter', 'Contacté', 'Relance 1', 'Relance 2', 'Réponse reçue', 'Opposition/refus', 'À vérifier'];
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

var STATUT_ENVOI_COLORS = { 'En attente': '#CCCCCC', 'En cours': '#F0AD4E', 'Envoyé': '#16B378', 'Erreur': '#D9534F' };
var TYPE_EMAIL_COLORS = { officiel: '#DDFBF4', générique: '#E8F3FA', reconstitué: '#FFF1D9', corrigé: '#FFF0EB' };
var TYPE_EMAIL_TEXT_COLORS = { officiel: '#116C5B', générique: '#35647D', reconstitué: '#8A5B0B', corrigé: '#A4472A' };

var FORMAT_EMAIL_CHOICES = ['prenom.nom', 'p.nom', 'prenom_nom', 'initiale+nom', 'autre'];
var STATUT_ENRICHISSEMENT_CHOICES = ['À enrichir', 'En cours', 'Terminé', 'Erreur'];

var departements = [];
var departementsById = {};
var contacts = [];
var contactsById = {};
var templates = [];
var templatesById = {};
var envois = [];
var parametres = { id: null, Webhook_Envoi_URL: '', Webhook_Desinscription_URL: '' };

var selectedIds = {}; // rowId -> true
var filters = { departement: '', statut: '', query: '', state: '' };
var currentTemplateId = null;
var currentTab = 'contacts';
var preparationInProgress = false;

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

window.addEventListener('unhandledrejection', function (event) {
  event.preventDefault();
  var message = event.reason && event.reason.message ? event.reason.message : 'Erreur inattendue';
  showToast('L’opération n’a pas pu aboutir : ' + message, 'error', 6000);
});

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
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

function gristValueToDateInput(v) {
  if (!v && v !== 0) return '';
  return new Date(v * 1000).toISOString().slice(0, 10);
}

function gristValueToDateTimeInput(v) {
  if (!v && v !== 0) return '';
  var date = new Date(Number(v) * 1000);
  var offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function dateTimeInputToGristValue(value) {
  if (!value) return null;
  return Math.floor(new Date(value).getTime() / 1000);
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
  body = EmailingRules.emailBodyWithUnsubscribe(body, link);
  return { subject: subject, body: body, html: EmailingRules.emailBodyToSafeHtml(body, link), linkMissing: linkMissing };
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

  var envoisData = await grist.docApi.fetchTable(ENVOIS_TABLE);
  envois = tableToRows(envoisData);
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
    if (c.Archive) return false;
    if (filters.departement && String(c.Departement) !== String(filters.departement)) return false;
    if (filters.statut && c.Statut !== filters.statut) return false;
    if (filters.query) {
      var haystack = [c.Prenom, c.Nom, c.Titre, c.Email_a_utiliser, c.Collectivite, c.Structure]
        .join(' ').toLowerCase();
      if (haystack.indexOf(filters.query.toLowerCase()) === -1) return false;
    }
    if (filters.state) {
      var state = EmailingRules.queueState(c);
      if (filters.state === 'relaunch' && !getRelaunchInfo(c).eligible) return false;
      if (filters.state === 'attention' && state !== 'blocked' && state !== 'error') return false;
      if (filters.state === 'queue' && state !== 'ready' && state !== 'scheduled') return false;
      if (filters.state === 'draft' && state !== 'draft') return false;
      if (filters.state === 'sent' && state !== 'sent') return false;
    }
    return true;
  });
}

function getRelaunchInfo(contact) {
  return EmailingRules.relaunchEligibility(contact, envois, parametres);
}

function badge(text, bg, color) {
  return '<span class="badge" style="background:' + (bg || '#EEE') + ';color:' + (color || '#000') + '">' + esc(text || '—') + '</span>';
}

function scoreColor(score) {
  if (!score) return '#F0F2F4';
  if (score.indexOf('100') === 0) return '#DDFBF4';
  if (score.indexOf('90') === 0) return '#E7F8F2';
  if (score.indexOf('80') === 0) return '#EFF8E5';
  if (score.indexOf('60') === 0) return '#FFF1D9';
  if (score.indexOf('40') === 0) return '#FFF0E8';
  return '#FDE9E5';
}

function scoreTextColor(score) {
  if (!score) return '#68707A';
  if (score.indexOf('100') === 0 || score.indexOf('90') === 0) return '#116C5B';
  if (score.indexOf('80') === 0) return '#4E702B';
  if (score.indexOf('60') === 0) return '#8A5B0B';
  if (score.indexOf('40') === 0) return '#A45126';
  return '#A33A25';
}

function renderContactsTab() {
  var container = document.getElementById('tab-contacts');
  var filtered = getFilteredContacts();
  var selectedCount = Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; }).length;
  var summary = EmailingRules.summarize(contacts);
  var relaunchCount = contacts.filter(function (c) { return getRelaunchInfo(c).eligible; }).length;
  var hasActiveFilters = !!(filters.state || filters.statut || filters.departement || filters.query);

  var html = '';

  html += '<div class="workflow-strip">';
  html += '<span class="workflow-step"><i data-lucide="users"></i><strong>1. Sélectionner</strong></span><span class="workflow-arrow">›</span>';
  html += '<span class="workflow-step"><i data-lucide="badge-check"></i><strong>2. Vérification automatique</strong></span><span class="workflow-arrow">›</span>';
  html += '<span class="workflow-step"><i data-lucide="calendar-clock"></i><strong>3. Choisir l’envoi</strong></span><span class="workflow-arrow">›</span>';
  html += '<span class="workflow-step"><i data-lucide="activity"></i><strong>4. Suivre les résultats</strong></span>';
  html += '</div>';

  html += '<div class="overview-grid">';
  html += metricFilter('draft', summary.draft, 'À valider');
  html += metricFilter('queue', summary.ready + summary.scheduled, 'Prêts ou programmés');
  html += metricFilter('attention', summary.blocked + summary.error, 'À corriger');
  html += metricFilter('sent', summary.sent, 'Envoyés');
  html += metricFilter('relaunch', relaunchCount, 'Relances à préparer');
  html += '</div>';

  // --- Toolbar filtres ---
  html += '<div class="toolbar">';
  html += '<input class="search-field" id="filter-query" type="text" value="' + esc(filters.query) + '" oninput="onQueryFilterChange(this)" placeholder="Rechercher un nom, email, structure…">';
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
  if (hasActiveFilters) {
    html += '<button class="btn btn-sm" onclick="resetContactFilters()"><i data-lucide="filter-x"></i> Réinitialiser les filtres</button>';
  }
  html += '<div class="spacer"></div>';
  html += '<button class="btn btn-primary" onclick="openNewContactModal()"><i data-lucide="user-plus"></i> Nouveau contact</button>';
  html += '</div>';

  // --- Barre de sélection / actions groupées ---
  html += '<div class="selection-bar">';
  html += '<strong>' + selectedCount + ' sélectionné(s)</strong>';
  html += '<button class="btn btn-sm btn-danger" onclick="markOppositionSelection()" ' + (selectedCount ? '' : 'disabled') + '><i data-lucide="shield-x"></i> Opposition</button>';
  html += '<div class="spacer"></div>';
  if (filters.state === 'relaunch') {
    html += '<button class="btn btn-primary btn-sm" onclick="openSendModal(null, true)" ' + (selectedCount ? '' : 'disabled') + '><i data-lucide="refresh-cw"></i> Préparer les relances</button>';
  } else {
    html += '<button class="btn btn-primary btn-sm" onclick="openSendModal()" ' + (selectedCount ? '' : 'disabled') + '><i data-lucide="send"></i> Préparer l’envoi</button>';
  }
  html += '</div>';

  // --- Table ---
  var allVisibleSelected = filtered.length > 0 && filtered.every(function (c) { return !!selectedIds[c.id]; });
  html += '<div class="contacts-table-wrapper"><table class="contacts-table"><thead><tr>';
  html += '<th><input type="checkbox" id="select-all" ' + (allVisibleSelected ? 'checked' : '') + ' onchange="event.stopPropagation(); toggleSelectAllVisible(this.checked)"></th>';
  html += '<th>Contact</th><th>Organisation</th><th>Email</th><th>Qualité</th>';
  html += '<th class="table-status">Statut</th><th class="table-send-state">Envoi</th><th class="table-action"></th>';
  html += '</tr></thead><tbody>';

  filtered.forEach(function (c) {
    var checked = !!selectedIds[c.id];
    html += '<tr onclick="openContactDetailModal(' + c.id + ')">';
    html += '<td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" data-id="' + c.id + '" ' + (checked ? 'checked' : '') + ' onchange="toggleRowSelect(' + c.id + ', this.checked)"></td>';
    var department = departementsById[c.Departement];
    var personName = ((c.Prenom || '') + ' ' + (c.Nom || '')).trim() || 'Contact sans nom';
    html += '<td title="' + esc(c.Titre) + '"><span class="contact-main">' + esc(personName) + '</span><span class="contact-sub">' + esc(c.Titre || 'Fonction non renseignée') + '</span></td>';
    html += '<td><span class="org-main">' + esc(c.Structure || c.Collectivite || '—') + '</span><span class="contact-sub">' + esc([c.Collectivite !== c.Structure ? c.Collectivite : '', department && department.Nom].filter(Boolean).join(' · ')) + '</span></td>';
    html += '<td class="email-cell">' + esc(c.Email_a_utiliser || '—') + '</td>';
    html += '<td class="quality-cell">' + badge(c.Score_confiance ? c.Score_confiance.split(' - ')[0] + '%' : '—', scoreColor(c.Score_confiance), scoreTextColor(c.Score_confiance)) + badge(c.Type_email, TYPE_EMAIL_COLORS[c.Type_email], TYPE_EMAIL_TEXT_COLORS[c.Type_email]) + '</td>';
    html += '<td class="table-status" onclick="event.stopPropagation()">' + selectMini(c.id, 'Statut', STATUT_CHOICES, c.Statut) + '</td>';
    var state = EmailingRules.queueState(c);
    var stateLabels = { draft: 'À valider', blocked: 'Bloqué', ready: 'Prêt', scheduled: 'Programmé', processing: 'En cours', sent: 'Envoyé', error: 'Erreur' };
    var stateColors = { draft: '#9CA3AF', blocked: '#D9534F', ready: '#2563EB', scheduled: '#F0AD4E', processing: '#F0AD4E', sent: '#16B378', error: '#D9534F' };
    html += '<td class="table-send-state"><span title="' + esc(c.Erreur_envoi || EmailingRules.blockingReasons(c).join(' · ')) + '"><span class="state-dot" style="background:' + stateColors[state] + '"></span>' + stateLabels[state] + '</span></td>';
    html += '<td class="table-action" onclick="event.stopPropagation()"><button class="btn btn-icon" title="Préparer cet envoi" onclick="openSendModal(' + c.id + ')"><i data-lucide="send"></i></button></td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
  refreshIcons();
}

function metricFilter(state, value, label) {
  var active = filters.state === state;
  var title = active ? 'Afficher à nouveau tous les contacts' : 'Filtrer la liste : ' + label;
  return '<button class="metric metric-' + state + ' ' + (active ? 'active' : '') + '" aria-pressed="' + active + '" title="' + esc(title) + '" onclick="setStateFilter(\'' + state + '\')"><div class="metric-value">' + value + '</div><div class="metric-label">' + esc(label) + '</div></button>';
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
  filters.query = document.getElementById('filter-query').value.trim();
  renderContactsTab();
}

function onQueryFilterChange(input) {
  var cursorPosition = input.selectionStart;
  filters.query = input.value;
  renderContactsTab();

  var refreshedInput = document.getElementById('filter-query');
  if (refreshedInput) {
    refreshedInput.focus();
    refreshedInput.setSelectionRange(cursorPosition, cursorPosition);
  }
}

function setStateFilter(state) {
  filters.state = filters.state === state ? '' : state;
  renderContactsTab();
}

function resetContactFilters() {
  filters = { departement: '', statut: '', query: '', state: '' };
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

async function markOppositionSelection() {
  var ids = Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; }).map(Number);
  if (ids.length === 0) return;
  if (!confirm(ids.length + ' contact(s) seront marqués en opposition et ne seront plus jamais proposés à l\'envoi. Confirmer ?')) return;
  await grist.docApi.applyUserActions([
    ['BulkUpdateRecord', CONTACTS_TABLE, ids, {
      Opposition: ids.map(function () { return true; }),
      Statut: ids.map(function () { return 'Opposition/refus'; }),
      Date_opposition: ids.map(function () { return Math.floor(Date.now() / 1000); }),
      Origine_opposition: ids.map(function () { return 'Saisie manuelle'; })
    }]
  ]);
  ids.forEach(function (id) { contactsById[id].Opposition = true; contactsById[id].Statut = 'Opposition/refus'; });
  showToast(ids.length + ' contact(s) marqué(s) en opposition.', 'success');
  renderContactsTab();
}

// =============================================================================
// NOUVEAU CONTACT (formulaire manuel)
// =============================================================================

var TYPE_EMAIL_CHOICES = ['officiel', 'générique', 'reconstitué', 'corrigé'];

function openNewContactModal() {
  var modalContainer = document.getElementById('modal-container');
  var html = '<div class="modal-overlay" onclick="if(event.target===this) closeModal()">';
  html += '<div class="modal modal-wide new-contact-modal">';
  html += '<div class="modal-header"><h2>Nouveau contact</h2><button class="modal-close" onclick="closeModal()">✕</button></div>';
  html += '<div class="modal-body"><div class="form-grid">';

  html += '<div class="contact-section new-contact-section identity-section"><i data-lucide="user-round"></i> Identité du prospect</div>';
  html += '<div class="form-field"><label>Département *</label><select id="nc-departement">';
  departements.forEach(function (d) {
    html += '<option value="' + d.id + '">' + esc(d.Nom) + '</option>';
  });
  html += '</select></div>';
  html += '<div class="form-field"><label>Service ciblé</label><input type="text" id="nc-service"></div>';

  html += '<div class="form-field"><label>Prénom *</label><input type="text" id="nc-prenom"></div>';
  html += '<div class="form-field"><label>Nom *</label><input type="text" id="nc-nom"></div>';
  html += '<div class="form-field"><label>Civilité à utiliser</label><select id="nc-civilite"><option value="">Automatique / à vérifier</option><option value="Madame">Madame</option><option value="Monsieur">Monsieur</option></select></div>';
  html += '<div class="form-field form-field-full"><label>Titre</label><input type="text" id="nc-titre"></div>';

  html += '<div class="contact-section new-contact-section email-section"><i data-lucide="mail-check"></i> Adresse et vérification</div>';
  html += '<div class="form-field"><label>Adresse email</label><input type="email" id="nc-email" placeholder="ex. prenom.nom@domaine.fr"></div>';
  html += '<div class="form-field"><label>Type d\'e-mail</label><select id="nc-type"><option value="">Automatique (déduit de l\'e-mail saisi)</option>';
  TYPE_EMAIL_CHOICES.forEach(function (t) {
    html += '<option value="' + esc(t) + '">' + esc(t) + '</option>';
  });
  html += '</select></div>';
  html += '<div class="form-field"><label>Niveau de confiance</label><select id="nc-score"><option value="">À évaluer</option><option value="100 - Email trouvé officiellement sur le site">100 - Trouvé sur le site officiel</option><option value="90 - Email corrigé par humain / validé Hunter.io">90 - Vérifié par une personne ou un outil</option><option value="80 - Format email confirmé sur le même domaine">80 - Format confirmé sur le domaine</option><option value="60 - Email reconstitué sans validation">60 - Reconstitué sans validation</option><option value="40 - Nom trouvé mais email incertain">40 - Email incertain</option></select></div>';
  html += urlFieldHtml('nc-source-email', 'Source de l’adresse email', '');
  html += urlFieldHtml('nc-source-nom', 'Source du nom et du poste', '');
  html += '<div class="form-field-full variables-hint">La structure et la collectivité sont automatiquement reprises depuis le département. Si l’adresse n’est pas connue, laissez-la vide : elle pourra être complétée ou calculée avant validation.</div>';

  html += '</div></div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn" onclick="closeModal()">Annuler</button>';
  html += '<button class="btn btn-primary" onclick="submitNewContact()">Ajouter</button>';
  html += '</div></div></div>';

  modalContainer.innerHTML = html;
  refreshIcons();
}

async function submitNewContact() {
  var departementId = Number(document.getElementById('nc-departement').value);
  var prenom = document.getElementById('nc-prenom').value.trim();
  var nom = document.getElementById('nc-nom').value.trim();
  var titre = document.getElementById('nc-titre').value.trim();
  var service = document.getElementById('nc-service').value.trim();
  var email = document.getElementById('nc-email').value.trim();
  var typeChoice = document.getElementById('nc-type').value;
  var civilite = document.getElementById('nc-civilite').value;
  var score = document.getElementById('nc-score').value;
  var sourceEmail = document.getElementById('nc-source-email').value.trim();
  var sourceNom = document.getElementById('nc-source-nom').value.trim();

  if (!departementId) { showToast('Choisissez un département.', 'error'); return; }
  if (!prenom || !nom) { showToast('Prénom et Nom sont obligatoires.', 'error'); return; }
  if (email && !EmailingRules.validEmail(email)) { showToast('Le format de l’adresse email est invalide.', 'error'); return; }

  var normalizedEmail = email.toLowerCase();
  var duplicate = contacts.find(function (contact) {
    var sameEmail = normalizedEmail && String(contact.Email_a_utiliser || contact.Email_trouvee || '').trim().toLowerCase() === normalizedEmail;
    var sameIdentity = Number(contact.Departement) === departementId &&
      EmailingRules.normalize(contact.Prenom) === EmailingRules.normalize(prenom) &&
      EmailingRules.normalize(contact.Nom) === EmailingRules.normalize(nom);
    return sameEmail || sameIdentity;
  });
  if (duplicate && !confirm('Un contact similaire existe déjà : ' + ((duplicate.Prenom || '') + ' ' + (duplicate.Nom || '')).trim() + '. Ajouter quand même ce contact ?')) return;

  var fields = {
    Departement: departementId,
    Prenom: prenom,
    Nom: nom,
    Titre: titre,
    Service: service,
    Civilite_corrigee: civilite,
    Score_confiance: score,
    Source_email: sourceEmail,
    Source_nom: sourceNom,
    Statut: 'Nouveau (à valider)',
    Statut_envoi: 'En attente',
    Reponse: 'Pas de réponse'
  };
  if (email) fields.Email_trouvee = email;

  var result = await grist.docApi.applyUserActions([['AddRecord', CONTACTS_TABLE, null, fields]]);
  var newId = result.retValues[0];

  // Le Type_email se recalcule automatiquement à la création (trigger) ; s'il faut un
  // choix précis (ex. "officiel"), on l'applique après coup pour qu'il ne soit pas écrasé.
  if (typeChoice) {
    await grist.docApi.applyUserActions([['UpdateRecord', CONTACTS_TABLE, newId, { Type_email: typeChoice }]]);
  }

  closeModal();
  await loadAllData();
  renderCurrentTab();
  showToast('Contact ajouté.', 'success');
}

// =============================================================================
// FICHE CONTACT (clic sur une ligne)
// =============================================================================

function urlFieldHtml(inputId, label, value) {
  var isUrl = /^https?:\/\//i.test(value || '');
  var html = '<div class="form-field"><label>' + esc(label) + '</label>';
  html += '<div style="display:flex; gap:6px;">';
  html += '<input type="text" id="' + inputId + '" value="' + esc(value) + '" style="flex:1;">';
  if (isUrl) {
    html += '<a href="' + esc(value) + '" target="_blank" rel="noopener noreferrer" class="btn btn-sm" title="Ouvrir le lien" style="text-decoration:none; display:flex; align-items:center; flex-shrink:0;">↗</a>';
  }
  html += '</div></div>';
  return html;
}

function selectOptions(id, choices, current, includeBlank) {
  var html = '<select id="' + id + '">';
  if (includeBlank) html += '<option value=""' + (!current ? ' selected' : '') + '>—</option>';
  choices.forEach(function (choice) {
    html += '<option value="' + esc(choice) + '"' + (choice === current ? ' selected' : '') + '>' + esc(choice) + '</option>';
  });
  html += '</select>';
  return html;
}

function openContactDetailModal(id) {
  var c = contactsById[id];
  if (!c) return;
  var blockingReasons = EmailingRules.blockingReasons(c);
  var contactState = EmailingRules.queueState(c);
  var modalContainer = document.getElementById('modal-container');

  var html = '<div class="modal-overlay" onclick="if(event.target===this) closeModal()">';
  var fullName = (c.Prenom + ' ' + c.Nom).trim() || 'Contact';
  var initials = ((c.Prenom || '').charAt(0) + (c.Nom || '').charAt(0)).toUpperCase() || '?';
  html += '<div class="modal modal-wide contact-modal">';
  html += '<div class="modal-header"><div class="contact-heading"><div class="contact-avatar">' + esc(initials) + '</div><div><h2>' + esc(fullName) + '</h2><p>' + esc(c.Titre || 'Fonction non renseignée') + '</p></div></div><button class="modal-close" title="Fermer" onclick="closeModal()">×</button></div>';
  html += '<div class="modal-body"><div class="form-grid">';

  if (contactState === 'sent') {
    var sentDate = c.Date_Envoi ? new Date(Number(c.Date_Envoi) * 1000).toLocaleDateString('fr-FR') : '';
    html += contactStatusBanner('status-sent', 'circle-check', 'Email déjà envoyé' + (sentDate ? ' le ' + esc(sentDate) : ''), 'Ce contact reste protégé contre un nouvel envoi automatique.');
  } else if (contactState === 'processing') {
    html += contactStatusBanner('status-warning', 'loader-circle', 'Envoi en cours', 'n8n traite actuellement ce contact.');
  } else if (contactState === 'error' && c.Erreur_envoi) {
    html += contactStatusBanner('status-error', 'circle-alert', 'Dernier envoi en erreur', esc(c.Erreur_envoi));
  } else if (blockingReasons.length) {
    html += contactStatusBanner('status-error', 'circle-alert', 'À corriger avant l’envoi', esc(blockingReasons.join(' · ')));
  } else if (contactState === 'ready' || contactState === 'scheduled') {
    html += contactStatusBanner('status-ready', 'badge-check', contactState === 'scheduled' ? 'Envoi programmé' : 'Contact prêt pour l’envoi', 'Les contrôles indispensables sont validés.');
  }

  html += contactChecklist(c);

  html += '<div class="contact-section detail-section identity-section"><i data-lucide="user-round"></i> Identité et fonction</div>';
  html += '<div class="form-field"><label>Département</label><select id="fc-departement">';
  departements.forEach(function (d) {
    html += '<option value="' + d.id + '"' + (c.Departement === d.id ? ' selected' : '') + '>' + esc(d.Nom) + '</option>';
  });
  html += '</select></div>';
  html += '<div class="form-field"><label>Service ciblé</label><input type="text" id="fc-service" value="' + esc(c.Service) + '"></div>';
  html += '<div class="form-field"><label>Prénom</label><input type="text" id="fc-prenom" value="' + esc(c.Prenom) + '"></div>';
  html += '<div class="form-field"><label>Nom</label><input type="text" id="fc-nom" value="' + esc(c.Nom) + '"></div>';
  html += '<div class="form-field contact-important"><label>Civilité à utiliser</label>' + selectOptions('fc-civilite', ['Monsieur', 'Madame'], c.Civilite_corrigee, true) + '<span class="hint">Déduite : ' + esc(c.Civilite || 'inconnue') + '</span></div>';
  html += '<div class="form-field form-field-full"><label>Titre</label><input type="text" id="fc-titre" value="' + esc(c.Titre) + '"></div>';

  html += '<div class="contact-section detail-section email-section"><i data-lucide="mail-check"></i> Adresse email</div>';
  html += '<div class="form-field"><label>Email corrigé (correction manuelle)</label><input type="text" id="fc-email-corrige" value="' + esc(c.Email_corrige) + '"></div>';
  html += '<div class="form-field"><label>Email trouvée (n8n / à la création)</label><input type="text" id="fc-email-trouvee" value="' + esc(c.Email_trouvee) + '"></div>';
  html += '<div class="form-field"><label>Type d\'e-mail</label>' + selectOptions('fc-type', TYPE_EMAIL_CHOICES, c.Type_email, true) + '</div>';
  html += '<div class="form-field"><label>Score de confiance</label>' + selectOptions('fc-score', ['100 - Email trouvé officiellement sur le site', '90 - Email corrigé par humain / validé Hunter.io', '80 - Format email confirmé sur le même domaine', '60 - Email reconstitué sans validation', '40 - Nom trouvé mais email incertain', '20 - Aucune source fiable'], c.Score_confiance, true) + '</div>';
  html += '<div class="form-field form-field-full contact-important"><label>Email qui sera utilisé</label><div class="readonly-field">' + esc(c.Email_a_utiliser || '—') + '</div><span class="hint">Vérifiez cette adresse et son niveau de confiance avant de préparer l’envoi.</span></div>';

  html += '<div class="contact-section detail-section followup-section"><i data-lucide="send"></i> Préparation et suivi</div>';
  html += '<div class="form-field"><label>Statut</label>' + selectOptions('fc-statut', STATUT_CHOICES, c.Statut, false) + '</div>';
  html += '<div class="form-field"><label>Réponse</label>' + selectOptions('fc-reponse', REPONSE_CHOICES, c.Reponse, false) + '</div>';
  html += '<div class="form-field"><label>Date d\'envoi</label><input type="date" id="fc-date-envoi" value="' + gristValueToDateInput(c.Date_Envoi) + '"></div>';
  html += '<div class="form-field"><label>Date de réponse</label><input type="date" id="fc-date-reponse" value="' + gristValueToDateInput(c.Date_reponse) + '"></div>';
  html += urlFieldHtml('fc-source-email', 'Source (email)', c.Source_email);
  html += urlFieldHtml('fc-source-nom', 'Source (nom/poste)', c.Source_nom);
  html += '<div class="form-field form-field-full opposition-control"><label style="display:flex; flex-direction:row; align-items:center; gap:8px; text-transform:none; font-size:13px;color:#94351F;"><input type="checkbox" id="fc-opposition" ' + (c.Opposition ? 'checked' : '') + ' style="width:auto;"> Opposition exprimée : ne plus jamais recontacter</label></div>';
  html += '<div class="form-field form-field-full"><label>Motif de ne pas contacter</label><input type="text" id="fc-motif" value="' + esc(c.Motif_ne_pas_contacter) + '"></div>';

  html += '<div class="contact-meta">';
  html += '<div>Collectivité<strong>' + esc(c.Collectivite || '—') + '</strong></div>';
  html += '<div>Structure<strong>' + esc(c.Structure || '—') + '</strong></div>';
  html += '<div>Statut d\'envoi<strong>' + esc(c.Statut_envoi || '—') + '</strong></div>';
  html += '</div>';
  if (c.Erreur_envoi) html += '<div class="form-field-full error-box" style="margin-top:10px;">Erreur d\'envoi : ' + esc(c.Erreur_envoi) + '</div>';

  html += '</div></div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn" onclick="archiveContact(' + id + ')"><i data-lucide="archive"></i> Archiver</button>';
  html += '<button class="btn" onclick="closeModal()">Annuler</button>';
  html += '<button class="btn btn-primary" onclick="submitContactDetail(' + id + ')">Enregistrer</button>';
  html += '<button class="btn btn-primary" onclick="submitContactDetail(' + id + ', true)"><i data-lucide="send"></i> Enregistrer et préparer l’envoi</button>';
  html += '</div></div></div>';

  modalContainer.innerHTML = html;
  refreshIcons();
}

function contactStatusBanner(className, icon, title, detail) {
  return '<div class="contact-status-banner ' + className + '"><i data-lucide="' + icon + '"></i><div><strong>' + title + '</strong><span>' + detail + '</span></div></div>';
}

function contactChecklist(c) {
  var checks = [
    { ok: EmailingRules.validEmail(c.Email_a_utiliser), label: c.Email_a_utiliser ? 'Format de l’email' : 'Email renseigné' },
    { ok: !c.Civilite_a_verifier && Boolean(c.Civilite_corrigee || c.Civilite), label: 'Civilité vérifiée' },
    { ok: Boolean(String(c.Sujet_final || '').trim()) && Boolean(String(c.Corps_final || '').trim()), label: 'Sujet et message prêts' },
    { ok: Boolean(String(c.Lien_Desinscription || '').trim()) && !c.Opposition, label: c.Opposition ? 'Opposition enregistrée' : 'Désinscription disponible' }
  ];
  var html = '<div class="check-panel"><div class="check-panel-title"><i data-lucide="clipboard-check"></i> À vérifier avant l’envoi</div><div class="check-grid">';
  checks.forEach(function (check) {
    html += '<div class="check-item ' + (check.ok ? 'check-ok' : 'check-bad') + '"><i data-lucide="' + (check.ok ? 'circle-check' : 'circle-x') + '"></i><span>' + esc(check.label) + '</span></div>';
  });
  return html + '</div></div>';
}

async function submitContactDetail(id, prepareAfterSave) {
  var dateEnvoi = document.getElementById('fc-date-envoi').value;
  var dateReponse = document.getElementById('fc-date-reponse').value;
  var wasOpposed = Boolean(contactsById[id].Opposition);
  var isOpposed = document.getElementById('fc-opposition').checked;
  var fields = {
    Departement: Number(document.getElementById('fc-departement').value),
    Service: document.getElementById('fc-service').value.trim(),
    Prenom: document.getElementById('fc-prenom').value.trim(),
    Nom: document.getElementById('fc-nom').value.trim(),
    Civilite_corrigee: document.getElementById('fc-civilite').value,
    Titre: document.getElementById('fc-titre').value.trim(),
    Email_corrige: document.getElementById('fc-email-corrige').value.trim(),
    Email_trouvee: document.getElementById('fc-email-trouvee').value.trim(),
    Type_email: document.getElementById('fc-type').value,
    Score_confiance: document.getElementById('fc-score').value,
    Statut: document.getElementById('fc-statut').value,
    Reponse: document.getElementById('fc-reponse').value,
    Source_email: document.getElementById('fc-source-email').value.trim(),
    Source_nom: document.getElementById('fc-source-nom').value.trim(),
    Date_Envoi: dateEnvoi ? dateToGristValue(dateEnvoi) : null,
    Date_reponse: dateReponse ? dateToGristValue(dateReponse) : null,
    Opposition: isOpposed,
    Motif_ne_pas_contacter: document.getElementById('fc-motif').value.trim()
  };

  if (isOpposed && !wasOpposed) {
    fields.Statut = 'Opposition/refus';
    fields.Date_opposition = Math.floor(Date.now() / 1000);
    fields.Origine_opposition = 'Saisie manuelle';
  }

  if (!fields.Prenom || !fields.Nom) { showToast('Prénom et Nom sont obligatoires.', 'error'); return; }

  await grist.docApi.applyUserActions([['UpdateRecord', CONTACTS_TABLE, id, fields]]);

  await loadAllData();
  renderCurrentTab();
  if (prepareAfterSave) {
    showToast('Contact enregistré. Vérifiez maintenant l’envoi.', 'success');
    openSendModal(id);
  } else {
    closeModal();
    showToast('Contact mis à jour.', 'success');
  }
}

async function archiveContact(id) {
  if (!confirm('Archiver ce contact ? Il sera retiré des listes actives et des relances, mais son historique sera conservé.')) return;
  await grist.docApi.applyUserActions([['UpdateRecord', CONTACTS_TABLE, id, {
    Archive: true,
    Date_archivage: Math.floor(Date.now() / 1000),
    Statut: 'À vérifier',
    Date_envoi_programmee: null
  }]]);
  closeModal();
  await loadAllData();
  renderCurrentTab();
  showToast('Contact archivé. Son historique est conservé.', 'success');
}

// =============================================================================
// SEND MODAL (individuel ou groupé)
// =============================================================================

function openSendModal(singleContactId, isRelaunch) {
  var ids = singleContactId ? [singleContactId] : Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; }).map(Number);
  if (ids.length === 0) { showToast('Aucun contact sélectionné.', 'error'); return; }
  var selected = ids.map(function (id) { return contactsById[id]; }).filter(Boolean);
  var preparable = selected.filter(function (c) { return isRelaunch ? getRelaunchInfo(c).eligible : EmailingRules.canPrepareInitial(c, envois); });
  var blocked = selected.filter(function (c) { return isRelaunch ? !getRelaunchInfo(c).eligible : !EmailingRules.canPrepareInitial(c, envois); });
  var selectedTemplateId = currentTemplateId || (templates[0] && templates[0].id);
  window._prepareIds = preparable.map(function (c) { return c.id; });
  window._deliveryMode = 'Immédiat';
  window._preparingRelaunch = Boolean(isRelaunch);

  var modalContainer = document.getElementById('modal-container');
  var html = '<div class="modal-overlay" onclick="if(event.target===this) closeModal()">';
  html += '<div class="modal modal-wide">';
  html += '<div class="modal-header"><div><h2>' + (isRelaunch ? 'Préparer les relances' : 'Préparer l’envoi') + '</h2><div class="hint">n8n prendra en charge l’envoi et le suivi</div></div><button class="modal-close" title="Fermer" onclick="closeModal()">×</button></div>';
  html += '<div class="modal-body">';
  html += '<div class="form-grid">';
  html += '<div class="form-field form-field-full"><label>Moment de l’envoi</label><div class="segmented">';
  html += '<button id="delivery-immediate" class="active" onclick="setDeliveryMode(\'Immédiat\')"><i data-lucide="send"></i> Dès le prochain passage</button>';
  html += '<button id="delivery-scheduled" onclick="setDeliveryMode(\'Programmé\')"><i data-lucide="calendar-clock"></i> Programmer</button>';
  html += '</div></div>';
  html += '<div class="form-field form-field-full hidden" id="scheduled-field"><label>Date et heure</label><input type="datetime-local" id="send-scheduled-at"></div>';
  html += '<div class="form-field form-field-full"><label>Modèle d’email</label><select id="send-template-select" onchange="refreshPrepareSummary()">';
  templates.forEach(function (t) {
    html += '<option value="' + t.id + '"' + (t.id === selectedTemplateId ? ' selected' : '') + '>' + esc(t.Nom) + '</option>';
  });
  html += '</select></div></div>';
  if (blocked.length) {
    html += '<div class="warning-box"><strong>' + blocked.length + ' contact(s) à corriger avant l’envoi</strong></div>';
    html += '<div class="review-list">';
    blocked.forEach(function (c) {
      var reasons = isRelaunch ? [getRelaunchInfo(c).reason] : EmailingRules.initialPreparationBlockingReasons(c, envois);
      var state = EmailingRules.queueState(c);
      if (!reasons.length && state === 'sent') reasons = ['Email déjà envoyé'];
      if (!reasons.length && state === 'processing') reasons = ['Envoi déjà en cours'];
      html += '<div class="review-row"><div><strong>' + esc((c.Prenom + ' ' + c.Nom).trim()) + '</strong><small>' + esc(reasons.join(' · ') || 'Contact indisponible pour l’envoi') + '</small></div>';
      html += '<button class="btn btn-sm" onclick="openContactDetailModal(' + c.id + ')"><i data-lucide="pencil"></i> Corriger</button></div>';
    });
    html += '</div>';
  }
  html += '<div id="prepare-summary"></div>';
  html += '</div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn" onclick="closeModal()">Annuler</button>';
  html += '<button class="btn btn-primary" id="send-confirm-btn" onclick="confirmPrepare()" ' + (preparable.length === 0 ? 'disabled' : '') + '><i data-lucide="check"></i> Préparer ' + preparable.length + (isRelaunch ? ' relance(s)' : ' contact(s)') + '</button>';
  html += '</div></div></div>';

  modalContainer.innerHTML = html;
  refreshPrepareSummary();
  refreshIcons();
}

function setDeliveryMode(mode) {
  window._deliveryMode = mode;
  document.getElementById('delivery-immediate').classList.toggle('active', mode === 'Immédiat');
  document.getElementById('delivery-scheduled').classList.toggle('active', mode === 'Programmé');
  document.getElementById('scheduled-field').classList.toggle('hidden', mode !== 'Programmé');
}

function refreshPrepareSummary() {
  var target = document.getElementById('prepare-summary');
  if (!target) return;
  var ids = window._prepareIds || [];
  var templateId = Number(document.getElementById('send-template-select').value);
  var template = templatesById[templateId];
  var html = '<div class="review-list">';
  ids.slice(0, 5).forEach(function (id) {
    var c = contactsById[id];
    var relaunch = window._preparingRelaunch ? getRelaunchInfo(c) : null;
    var reasons = window._preparingRelaunch ? (relaunch.eligible ? [] : [relaunch.reason]) : EmailingRules.initialPreparationBlockingReasons(c, envois);
    html += '<div class="review-row"><div><strong>' + esc((c.Prenom + ' ' + c.Nom).trim()) + '</strong><small>' + esc(c.Email_a_utiliser) + '</small></div><div>' + (reasons.length ? badge('À corriger', '#D9534F', '#fff') : badge(relaunch ? relaunch.nextType : 'Prêt', '#E8F5EE', '#157A54')) + '</div></div>';
  });
  if (ids.length > 5) html += '<div class="hint">Et ' + (ids.length - 5) + ' autre(s) contact(s).</div>';
  html += '</div>';
  if (template && ids.length) {
    var sample = contactsById[ids[0]];
    var built = buildEmailForContact(template, sample);
    html += '<div class="field-label">Aperçu pour ' + esc(sample.Prenom) + '</div><div class="readonly-field"><strong>' + esc(built.subject) + '</strong><br><br>' + built.html + '</div>';
  }
  target.innerHTML = html;
}

async function confirmPrepare() {
  var ids = window._prepareIds || [];
  var mode = window._deliveryMode || 'Immédiat';
  var templateId = Number(document.getElementById('send-template-select').value);
  var scheduledInput = document.getElementById('send-scheduled-at');
  var scheduledValue = scheduledInput ? scheduledInput.value : '';
  var isRelaunch = Boolean(window._preparingRelaunch);
  if (!ids.length || preparationInProgress) return;
  if (!templatesById[templateId]) { showToast('Choisissez un modèle.', 'error'); return; }
  if (mode === 'Programmé' && !scheduledValue) { showToast('Choisissez une date et une heure.', 'error'); return; }
  if (mode === 'Programmé' && new Date(scheduledValue).getTime() <= Date.now()) { showToast('La programmation doit être dans le futur.', 'error'); return; }
  var stillEligible = ids.every(function (id) {
    var contact = contactsById[id];
    if (!contact) return false;
    return isRelaunch ? getRelaunchInfo(contact).eligible : EmailingRules.canPrepareInitial(contact, envois);
  });
  if (!stillEligible) {
    showToast('La situation d’un contact a changé. Actualisez la préparation avant de continuer.', 'error', 6000);
    return;
  }

  var confirmButton = document.getElementById('send-confirm-btn');
  preparationInProgress = true;
  if (confirmButton) confirmButton.disabled = true;
  try {
    var actions = [];
    var createdAt = Math.floor(Date.now() / 1000);
    ids.forEach(function (id) {
      var contact = contactsById[id];
      var template = templatesById[templateId];
      var built = buildEmailForContact(template, contact);
      actions.push(['AddRecord', ENVOIS_TABLE, null, {
        Contact: id,
        Type_envoi: isRelaunch ? getRelaunchInfo(contact).nextType : 'Premier envoi',
        Template: templateId,
        Mode_envoi: mode,
        Date_programmee: mode === 'Programmé' ? dateTimeInputToGristValue(scheduledValue) : null,
        Statut_envoi: 'En attente',
        Email_destinataire: contact.Email_a_utiliser,
        Sujet: built.subject,
        Date_creation: createdAt
      }]);
    });
    actions.push(
      ['BulkUpdateRecord', CONTACTS_TABLE, ids, {
        Template: ids.map(function () { return templateId; }),
        Mode_envoi: ids.map(function () { return mode; }),
        Date_envoi_programmee: ids.map(function () { return mode === 'Programmé' ? dateTimeInputToGristValue(scheduledValue) : null; }),
        Statut: ids.map(function (id) { return isRelaunch ? getRelaunchInfo(contactsById[id]).nextType : 'À contacter'; }),
        Statut_envoi: ids.map(function () { return 'En attente'; }),
        Erreur_envoi: ids.map(function () { return ''; })
      }]
    );
    await grist.docApi.applyUserActions(actions);
    selectedIds = {};
    showToast(ids.length + (isRelaunch ? ' relance(s)' : ' contact(s)') + ' préparé(s). n8n les traitera au prochain passage.', 'success', 5500);
  } catch (e) {
    showToast('Impossible de préparer l’envoi : ' + e.message, 'error');
    if (confirmButton) confirmButton.disabled = false;
    return;
  } finally {
    preparationInProgress = false;
  }
  closeModal();
  await loadAllData();
  renderCurrentTab();
}

function closeModal() {
  document.getElementById('modal-container').innerHTML = '';
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
    html += '<div class="variables-hint">Variables disponibles : <code>{Civilite}</code> <code>{Prenom}</code> <code>{Nom}</code> <code>{Titre}</code> <code>{Structure}</code> <code>{Collectivite}</code> <code>{Email_a_utiliser}</code>. Pour insérer un lien : <code>[Découvrir notre site](https://exemple.fr)</code>. Le lien « Se désinscrire » est ajouté automatiquement en pied de message.</div>';
    html += '<div style="margin-top:14px; display:flex; gap:8px;">';
    html += '<button class="btn btn-primary" onclick="saveTemplate(' + current.id + ')">Enregistrer</button>';
    html += '<button class="btn btn-danger" onclick="deactivateTemplate(' + current.id + ')">Désactiver</button>';
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

async function deactivateTemplate(id) {
  if (!confirm('Désactiver ce modèle ? Il restera conservé dans l’historique des envois.')) return;
  await grist.docApi.applyUserActions([['UpdateRecord', TEMPLATES_TABLE, id, { Actif: false }]]);
  currentTemplateId = null;
  await loadAllData();
  showToast('Modèle désactivé. Son historique est conservé.', 'success');
  renderTemplatesTab();
}

// =============================================================================
// SETTINGS TAB
// =============================================================================

function renderSettingsTab() {
  var container = document.getElementById('tab-settings');
  var html = '<div class="settings-form">';
  html += '<div class="field-label">Automatisation des envois</div>';
  html += '<div class="readonly-field">Les contacts préparés sont pris en charge par le workflow n8n publié, toutes les 5 minutes.</div>';

  html += '<div class="field-label">URL webhook n8n — désinscription</div>';
  html += '<input type="text" id="set-webhook-desinscription" value="' + esc(parametres.Webhook_Desinscription_URL || '') + '" placeholder="https://...">';
  html += '<div class="hint">Génère le lien unique par contact (colonne Lien_Desinscription) inséré dans chaque email.</div>';

  html += '<div class="contact-section"><i data-lucide="refresh-cw"></i> Relances</div>';
  html += '<div class="form-field"><label style="display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;"><input type="checkbox" id="set-relances-activees" ' + (parametres.Relances_activees ? 'checked' : '') + '> Proposer automatiquement les contacts à relancer</label></div>';
  html += '<div class="form-grid" style="margin-top:12px;">';
  html += '<div class="form-field"><label>Délai avant Relance 1</label><input type="number" id="set-delai-relance-1" min="0" max="365" value="' + Number(parametres.Delai_relance_1_jours || 15) + '"><span class="hint">jours après le premier envoi</span></div>';
  html += '<div class="form-field"><label>Délai avant Relance 2</label><input type="number" id="set-delai-relance-2" min="0" max="365" value="' + Number(parametres.Delai_relance_2_jours || 15) + '"><span class="hint">jours après la première relance</span></div>';
  html += '<div class="form-field"><label>Nombre maximal de relances</label><input type="number" id="set-max-relances" min="0" max="2" value="' + Number(parametres.Nombre_max_relances == null ? 2 : parametres.Nombre_max_relances) + '"></div>';
  html += '</div><div class="hint">Les contacts deviennent visibles dans « Relances à préparer ». Aucun message ne part sans validation.</div>';

  html += '<div style="margin-top:16px;"><button class="btn btn-primary" onclick="saveSettings()">Enregistrer</button></div>';
  html += '</div>';

  html += '<div class="settings-form" style="margin-top:20px;">';
  html += '<div class="toolbar" style="margin-bottom:10px;"><strong style="flex:1;">Départements</strong><button class="btn btn-primary btn-sm" onclick="openDepartementModal()">+ Ajouter un département</button></div>';
  html += '<table class="contacts-table"><thead><tr><th>Nom</th><th>Structure</th><th>Code</th><th>Domaine e-mail</th><th>Format e-mail</th><th>Enrichissement</th><th></th></tr></thead><tbody>';
  departements.forEach(function (d) {
    html += '<tr>';
    html += '<td>' + esc(d.Nom) + '</td>';
    html += '<td>' + esc(d.Structure) + '</td>';
    html += '<td>' + esc(d.Code_departement) + '</td>';
    html += '<td class="email-cell">' + esc(d.Domaine_email) + '</td>';
    html += '<td>' + esc(d.Format_email || '—') + '</td>';
    html += '<td>' + badge(d.Statut_enrichissement, { 'À enrichir': '#CCCCCC', 'En cours': '#5BC0DE', 'Terminé': '#16B378', 'Erreur': '#D9534F' }[d.Statut_enrichissement]) + '</td>';
    html += '<td><button class="btn btn-sm" onclick="openDepartementModal(' + d.id + ')">✏️</button></td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  html += '</div>';

  container.innerHTML = html;
  refreshIcons();
}

async function saveSettings() {
  var delay1 = Number(document.getElementById('set-delai-relance-1').value);
  var delay2 = Number(document.getElementById('set-delai-relance-2').value);
  var maxRelaunches = Number(document.getElementById('set-max-relances').value);
  if (!Number.isInteger(delay1) || !Number.isInteger(delay2) || delay1 < 0 || delay2 < 0) { showToast('Les délais doivent être des nombres entiers positifs.', 'error'); return; }
  if (!Number.isInteger(maxRelaunches) || maxRelaunches < 0 || maxRelaunches > 2) { showToast('Choisissez entre 0 et 2 relances.', 'error'); return; }
  var unsubscribeUrl = document.getElementById('set-webhook-desinscription').value.trim();
  if (!EmailingRules.validHttpsUrl(unsubscribeUrl)) { showToast('L’URL de désinscription doit être une adresse HTTPS valide.', 'error'); return; }
  var fields = {
    Webhook_Envoi_URL: parametres.Webhook_Envoi_URL || '',
    Webhook_Desinscription_URL: unsubscribeUrl,
    Relances_activees: document.getElementById('set-relances-activees').checked,
    Delai_relance_1_jours: delay1,
    Delai_relance_2_jours: delay2,
    Nombre_max_relances: maxRelaunches
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
// DÉPARTEMENTS (ajout/édition depuis Paramètres)
// =============================================================================

function openDepartementModal(id) {
  var d = id ? departementsById[id] : null;
  var modalContainer = document.getElementById('modal-container');
  var html = '<div class="modal-overlay" onclick="if(event.target===this) closeModal()">';
  html += '<div class="modal modal-wide">';
  html += '<div class="modal-header"><h2>' + (d ? 'Modifier le département' : 'Nouveau département') + '</h2><button class="modal-close" onclick="closeModal()">✕</button></div>';
  html += '<div class="modal-body"><div class="form-grid">';

  html += '<div class="form-field"><label>Nom *</label><input type="text" id="dep-nom" value="' + (d ? esc(d.Nom) : '') + '" placeholder="ex. Essonne"></div>';
  html += '<div class="form-field"><label>Structure (code court)</label><input type="text" id="dep-structure" value="' + (d ? esc(d.Structure) : '') + '" placeholder="ex. CD91"></div>';
  html += '<div class="form-field"><label>Code département</label><input type="text" id="dep-code" value="' + (d ? esc(d.Code_departement) : '') + '" placeholder="ex. 91"></div>';
  html += '<div class="form-field"><label>Domaine e-mail *</label><input type="text" id="dep-domaine" value="' + (d ? esc(d.Domaine_email) : '') + '" placeholder="ex. essonne.fr"></div>';
  html += '<div class="form-field form-field-full"><label>Nom complet de la structure</label><input type="text" id="dep-nom-structure" value="' + (d ? esc(d.Nom_Structure) : '') + '" placeholder="ex. Conseil départemental de l\'Essonne"></div>';
  html += '<div class="form-field form-field-full"><label>Site officiel</label><input type="text" id="dep-site" value="' + (d ? esc(d.Site_officiel) : '') + '" placeholder="https://..."></div>';

  html += '<div class="form-field"><label>Format e-mail</label><select id="dep-format"><option value="">Non confirmé</option>';
  FORMAT_EMAIL_CHOICES.forEach(function (f) {
    html += '<option value="' + esc(f) + '"' + (d && d.Format_email === f ? ' selected' : '') + '>' + esc(f) + '</option>';
  });
  html += '</select></div>';

  html += '<div class="form-field"><label>Statut d\'enrichissement</label><select id="dep-statut-enrichissement">';
  STATUT_ENRICHISSEMENT_CHOICES.forEach(function (s) {
    html += '<option value="' + esc(s) + '"' + (d ? (d.Statut_enrichissement === s ? ' selected' : '') : (s === 'À enrichir' ? ' selected' : '')) + '>' + esc(s) + '</option>';
  });
  html += '</select></div>';

  html += '<div class="form-field form-field-full"><label>Mots-clés de recherche</label><input type="text" id="dep-motscles" value="' + (d ? esc(d.Mots_cles_recherche) : '') + '"></div>';

  html += '</div></div>';
  html += '<div class="modal-footer">';
  if (d) html += '<button class="btn btn-danger" onclick="deleteDepartement(' + d.id + ')">Supprimer</button>';
  html += '<button class="btn" onclick="closeModal()">Annuler</button>';
  html += '<button class="btn btn-primary" onclick="submitDepartement(' + (d ? d.id : 'null') + ')">Enregistrer</button>';
  html += '</div></div></div>';

  modalContainer.innerHTML = html;
}

async function submitDepartement(id) {
  var nom = document.getElementById('dep-nom').value.trim();
  var domaine = document.getElementById('dep-domaine').value.trim();
  if (!nom) { showToast('Le nom du département est obligatoire.', 'error'); return; }
  if (!domaine) { showToast('Le domaine e-mail est obligatoire.', 'error'); return; }

  var fields = {
    Nom: nom,
    Structure: document.getElementById('dep-structure').value.trim(),
    Code_departement: document.getElementById('dep-code').value.trim(),
    Nom_Structure: document.getElementById('dep-nom-structure').value.trim(),
    Site_officiel: document.getElementById('dep-site').value.trim(),
    Domaine_email: domaine,
    Format_email: document.getElementById('dep-format').value,
    Mots_cles_recherche: document.getElementById('dep-motscles').value.trim(),
    Statut_enrichissement: document.getElementById('dep-statut-enrichissement').value
  };

  if (id) {
    await grist.docApi.applyUserActions([['UpdateRecord', DEPARTEMENTS_TABLE, id, fields]]);
  } else {
    await grist.docApi.applyUserActions([['AddRecord', DEPARTEMENTS_TABLE, null, fields]]);
  }

  closeModal();
  await loadAllData();
  renderSettingsTab();
  showToast('Département enregistré.', 'success');
}

async function deleteDepartement(id) {
  var linked = contacts.filter(function (c) { return c.Departement === id; }).length;
  if (linked > 0) {
    showToast(linked + ' contact(s) sont rattachés à ce département — réassignez-les ou supprimez-les avant de pouvoir supprimer ce département.', 'error', 6000);
    return;
  }
  if (!confirm('Supprimer ce département ?')) return;
  await grist.docApi.applyUserActions([['RemoveRecord', DEPARTEMENTS_TABLE, id]]);
  closeModal();
  await loadAllData();
  renderSettingsTab();
  showToast('Département supprimé.', 'success');
}

// =============================================================================
// INIT
// =============================================================================

if (!isInsideGrist()) {
  document.getElementById('not-in-grist').classList.remove('hidden');
  document.getElementById('main-content').classList.add('hidden');
} else {
  (async function () {
    try {
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
            loadAllData().then(renderCurrentTab).catch(function (error) {
              showToast('Impossible d’actualiser les données : ' + error.message, 'error', 6000);
            });
          }, 600);
        });
      }
    } catch (error) {
      document.getElementById('main-content').innerHTML = '<div class="error-box" style="margin:24px;">Impossible de charger le widget. Vérifiez son accès au document Grist puis actualisez la page.</div>';
    }
  })();
}
