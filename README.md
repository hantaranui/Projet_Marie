# Emailing Prospection - Widget Grist

Widget Grist pour préparer et suivre des campagnes de prospection envoyées par n8n et Gmail.

## Fonctions principales

- gestion et validation des contacts ;
- préparation d'envois immédiats ou programmés ;
- historique séparé dans la table `Envois` ;
- relances configurables avec contrôles de réponse, d'opposition et de rejet ;
- modèles personnalisables avec liens HTML sécurisés ;
- lien de désinscription ajouté automatiquement ;
- archivage des contacts et conservation de l'historique.

## Développement local

Prérequis : Python 3 et Node.js.

```bash
npm run dev
```

Le widget est alors disponible sur `http://127.0.0.1:8099/index.html`.

## Vérifications

```bash
npm run check
```

Cette commande vérifie la syntaxe JavaScript et exécute tous les tests unitaires.

## Configuration Grist

Le widget demande un accès complet au document et utilise les tables suivantes :

- `Contacts`
- `Departements`
- `Templates`
- `Parametres`
- `Envois`

Les identifiants de document, clés d'API, secrets Gmail et identifiants n8n ne doivent jamais être ajoutés au dépôt. Ils restent configurés dans Grist et n8n.

## Mise en production

1. Exécuter `npm run check`.
2. Déployer les fichiers statiques sur un domaine HTTPS.
3. Autoriser l'URL déployée comme widget personnalisé dans Grist.
4. Vérifier que le workflow n8n de production est publié.
5. Réaliser un test avec une adresse fictive avant toute campagne réelle.

