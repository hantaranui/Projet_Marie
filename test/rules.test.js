const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../rules.js');

function contact(overrides = {}) {
  return {
    Statut: 'À contacter',
    Statut_envoi: 'En attente',
    Email_a_utiliser: 'contact@example.com',
    Opposition: false,
    Motif_ne_pas_contacter: '',
    Civilite_a_verifier: false,
    Sujet_final: 'Bonjour',
    Corps_final: 'Message',
    Lien_Desinscription: 'https://example.com/unsubscribe?token=abc',
    Mode_envoi: 'Immédiat',
    ...overrides
  };
}

test('un contact complet est prêt', () => {
  assert.deepEqual(rules.blockingReasons(contact()), []);
  assert.equal(rules.queueState(contact()), 'ready');
});

test('le contrôle distingue un format invalide', () => {
  assert.deepEqual(rules.blockingReasons(contact({ Email_a_utiliser: 'contact@example.' })), ['Format d’adresse email invalide']);
  assert.equal(rules.queueState(contact({ Email_a_utiliser: 'contact@example.' })), 'blocked');
});

test('seule une URL HTTPS valide est acceptée pour la désinscription', () => {
  assert.equal(rules.validHttpsUrl('https://example.com/desinscription'), true);
  assert.equal(rules.validHttpsUrl('http://example.com/desinscription'), false);
  assert.equal(rules.validHttpsUrl('javascript:alert(1)'), false);
  assert.equal(rules.validHttpsUrl('pas-une-url'), false);
});

test('une opposition bloque toujours la préparation', () => {
  const c = contact({ Opposition: true });
  assert.equal(rules.blockingReasons(c).includes('Opposition exprimée'), true);
  assert.equal(rules.canPrepare(c), false);
});

test('un contact incomplet ne peut pas être préparé', () => {
  assert.equal(rules.canPrepare(contact({ Lien_Desinscription: '' })), false);
});

test('le sujet et le message seront fournis par le modèle choisi pendant la préparation', () => {
  const c = contact({ Sujet_final: '', Corps_final: '' });
  assert.deepEqual(rules.preparationBlockingReasons(c), []);
  assert.equal(rules.canPrepare(c), true);
});

test('un contact programmé est identifié', () => {
  assert.equal(rules.queueState(contact({ Mode_envoi: 'Programmé' })), 'scheduled');
});

test('un envoi terminé ne peut pas être préparé à nouveau', () => {
  const c = contact({ Statut_envoi: 'Envoyé' });
  assert.equal(rules.queueState(c), 'sent');
  assert.equal(rules.canPrepare(c), false);
});

test('un contact déjà traité ne peut pas repasser par un premier envoi', () => {
  const c = contact({ Statut: 'Contacté', Statut_envoi: 'En attente' });
  assert.equal(rules.canPrepare(c), false);
  assert.match(rules.preparationBlockingReasons(c).join(' '), /Statut incompatible/);
});

test('un historique en attente empêche une double préparation', () => {
  const c = contact({ id: 12 });
  const sends = [{ Contact: 12, Type_envoi: 'Premier envoi', Statut_envoi: 'En attente' }];
  assert.equal(rules.canPrepareInitial(c, sends), false);
  assert.match(rules.initialPreparationBlockingReasons(c, sends).join(' '), /déjà prévu/);
});

test('un premier envoi historique empêche un nouvel envoi initial malgré un statut réinitialisé', () => {
  const c = contact({ id: 13, Statut: 'À contacter', Statut_envoi: 'En attente' });
  const sends = [{ Contact: 13, Type_envoi: 'Premier envoi', Statut_envoi: 'Envoyé' }];
  assert.equal(rules.canPrepareInitial(c, sends), false);
  assert.match(rules.initialPreparationBlockingReasons(c, sends).join(' '), /déjà effectué/);
});

test('le résumé compte chaque état', () => {
  const result = rules.summarize([
    contact(),
    contact({ Mode_envoi: 'Programmé' }),
    contact({ Email_a_utiliser: '' }),
    contact({ Statut_envoi: 'Erreur' })
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.ready, 1);
  assert.equal(result.scheduled, 1);
  assert.equal(result.blocked, 1);
  assert.equal(result.error, 1);
});

test('les liens simples deviennent des liens HTML', () => {
  const html = rules.markdownLinksToSafeHtml('Voir [notre site](https://example.com/offre).');
  assert.match(html, /<a href="https:\/\/example\.com\/offre"/);
  assert.match(html, />notre site<\/a>/);
});

test('le HTML saisi est neutralisé et les protocoles dangereux ne deviennent pas cliquables', () => {
  const html = rules.markdownLinksToSafeHtml('<script>alert(1)</script> [ouvrir](javascript:alert(1))');
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('le pied de désinscription est ajouté une seule fois', () => {
  const url = 'https://example.com/unsubscribe?token=abc';
  const first = rules.emailBodyWithUnsubscribe('Bonjour', url);
  const second = rules.emailBodyWithUnsubscribe(first, url);
  assert.equal((second.match(/https:\/\/example\.com\/unsubscribe\?token=abc/g) || []).length, 1);
  assert.match(second, /\[Se désinscrire\]/);
});

test('une URL de désinscription brute venant de Grist devient un libellé court', () => {
  const url = 'https://example.com/unsubscribe?token=abc';
  const body = rules.emailBodyWithUnsubscribe('Pour ne plus recevoir nos emails : ' + url, url);
  assert.equal(body.includes(': ' + url), false);
  assert.match(body, /\[Se désinscrire\]\(https:\/\/example\.com\/unsubscribe\?token=abc\)/);
});

test('une relance devient éligible après le délai configuré', () => {
  const c = contact({ id: 7, Statut_envoi: 'Envoyé', Date_Envoi: 1000, Reponse: 'Pas de réponse' });
  const settings = { Relances_activees: true, Delai_relance_1_jours: 15, Delai_relance_2_jours: 15, Nombre_max_relances: 2 };
  const result = rules.relaunchEligibility(c, [], settings, 1000 + 15 * 86400);
  assert.equal(result.eligible, true);
  assert.equal(result.nextType, 'Relance 1');
});

test('une réponse ou une opposition empêche toute relance', () => {
  const settings = { Relances_activees: true, Delai_relance_1_jours: 15, Nombre_max_relances: 2 };
  assert.equal(rules.relaunchEligibility(contact({ id: 1, Reponse: 'Positif' }), [], settings).eligible, false);
  assert.equal(rules.relaunchEligibility(contact({ id: 1, Reponse: 'Pas de réponse', Opposition: true }), [], settings).eligible, false);
});

test('une relance en attente empêche une nouvelle préparation', () => {
  const c = contact({ id: 2, Statut_envoi: 'Envoyé', Date_Envoi: 1000, Reponse: 'Pas de réponse' });
  const sends = [{ Contact: 2, Type_envoi: 'Relance 1', Statut_envoi: 'En attente' }];
  const settings = { Relances_activees: true, Delai_relance_1_jours: 0, Nombre_max_relances: 2 };
  assert.equal(rules.relaunchEligibility(c, sends, settings, 2000).eligible, false);
});

test('un contact archivé ne peut jamais devenir éligible à une relance', () => {
  const c = contact({ id: 3, Archive: true, Statut_envoi: 'Envoyé', Date_Envoi: 1000, Reponse: 'Pas de réponse' });
  const settings = { Relances_activees: true, Delai_relance_1_jours: 0, Nombre_max_relances: 2 };
  assert.equal(rules.relaunchEligibility(c, [], settings, 2000).eligible, false);
});

test('une adresse non distribuée ne peut jamais être relancée', () => {
  const c = contact({ id: 4, Statut: 'Contacté', Statut_envoi: 'Non distribué', Date_Envoi: 1000, Reponse: 'Pas de réponse' });
  const settings = { Relances_activees: true, Delai_relance_1_jours: 0, Nombre_max_relances: 2 };
  assert.equal(rules.relaunchEligibility(c, [], settings, 2000).eligible, false);
});
