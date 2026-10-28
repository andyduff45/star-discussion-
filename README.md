# Star Discussion

Forum façon Discord pour ton agence. Tout est vérifié par le serveur et partagé en direct entre les membres.

- **Comptes** : inscription avec e-mail et mot de passe, puis vérification de l'e-mail par un code à 6 chiffres. Le code est valable 10 minutes et accepte 5 essais au maximum.
- **Mot de passe oublié** : un code est envoyé par e-mail pour en choisir un nouveau.
- **Salons** : salons texte en temps réel, salons vocaux (présence, micro, casque), sondages.
- **Panel admin** : rôles, permissions, membres (expulser, bannir), salons et journal.
- **Bots** : commandes, bienvenue, auto-modération, niveaux XP et messages programmés. Ils tournent sur le serveur.
- **Créateurs TikTok** : classement, heures, jours validés, diamants, objectifs et import CSV.
- **RedM / FiveM** : statut, mode crise, whitelist des joueurs et suivi des bugs.
- **Connexions** : chaque membre peut lier son compte TikTok.

Il n'y a aucune dépendance à installer : il faut seulement **Node.js 18 ou plus récent**.

## Lancer sur ton ordinateur

1. Installe Node.js depuis https://nodejs.org (version LTS).
2. Dans le dossier `star-discussion`, copie `.env.example` en `.env`.
3. Lance :
   ```
   node server.js
   ```
4. Ouvre http://localhost:3000 dans ton navigateur.

**Le premier compte créé devient Fondateur** (tous les droits). Tu peux aussi définir `ADMIN_EMAIL` dans `.env`.

Tant que `SMTP_HOST` est vide, l'app est en **mode test** : les codes ne sont pas envoyés par e-mail, ils s'affichent dans la console où tourne `node server.js`.

## Envoyer les vrais e-mails (Gmail)

1. Sur ton compte Google, active la validation en 2 étapes.
2. Crée un mot de passe d'application sur https://myaccount.google.com/apppasswords.
3. Dans `.env`, remplis les lignes suivantes :
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=ton.adresse@gmail.com
   SMTP_PASS=le mot de passe d'application, sans espaces
   MAIL_FROM=Star Discussion <ton.adresse@gmail.com>
   ```
4. Relance `node server.js`.

Ça marche aussi avec Brevo, Mailjet, OVH ou tout autre fournisseur SMTP : le port 465 utilise SSL, et le port 587 utilise STARTTLS automatiquement.

## Connexion TikTok

Dans l'onglet **Connexions**, chaque membre peut lier son TikTok de deux façons :

- **Par la bio (fonctionne tout de suite)** : le membre entre son @ et reçoit un code `STAR-XXXXXX`. Il le met dans sa bio TikTok, puis clique sur vérifier. Le serveur lit le profil public pour confirmer, puis récupère les abonnés, les j'aime et les vidéos. Le membre peut retirer le code ensuite.
- **Bouton « Se connecter avec TikTok » (officiel)** : crée une app sur https://developers.tiktok.com avec le produit *Login Kit* et les scopes `user.info.basic`, `user.info.profile` et `user.info.stats`. Mets l'URL de redirection `https://ton-site/api/tiktok/oauth/callback`, puis remplis `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` et `PUBLIC_URL` dans `.env`. TikTok doit valider l'app avant que les autres comptes puissent l'utiliser.

Les heures de live, les jours validés et les diamants ne sont pas accessibles par TikTok, même avec la connexion officielle. Ils restent dans ton espace agence TikTok LIVE Backstage : exporte-les et utilise **Importer CSV** dans l'onglet Créateurs.

La lecture des profils publics peut échouer si TikTok bloque temporairement le serveur. Dans ce cas, l'app affiche un message d'erreur sans inventer de chiffres.

## Mettre en ligne

N'importe quel hébergeur qui fait tourner Node.js convient, par exemple Railway, Render, un VPS ou un Raspberry Pi.

- La commande de démarrage est `node server.js`.
- Ajoute les variables de `.env` dans les réglages de l'hébergeur.
- Les données sont dans `data/db.json`. Sur Railway ou Render, ajoute un **volume persistant** et mets `DATA_DIR` sur ce volume, sinon les données sont effacées à chaque redéploiement.
- Si le site est en https, mets `COOKIE_SECURE=true`.

## Sécurité

- Les mots de passe sont hachés avec scrypt et ne sont jamais stockés en clair.
- Les codes e-mail sont hachés. Ils expirent après 10 minutes et sont limités à 5 essais.
- Les connexions et les envois de code sont limités pour bloquer les attaques par force brute.
- Chaque action (message, rôle, bot, RedM, FiveM…) est vérifiée côté serveur selon les permissions du rôle.
- Un compte banni ne peut plus se connecter.

## Fichiers

```
server.js          serveur : comptes, e-mails, temps réel, bots, TikTok
public/index.html  l'application
.env.example       modèle de configuration
data/db.json       données (créé au premier lancement)
```

## Sauvegarde gratuite avec Upstash (Render gratuit)

Sur l'offre gratuite de Render, le disque est effacé à chaque redémarrage. Pour tout garder sans payer :

1. Crée un compte gratuit sur https://upstash.com puis **Create Database** (Redis, région Europe).
2. Dans l'onglet **REST API** de la base, copie `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.
3. Ajoute ces deux variables dans Render (Environment), puis redéploie.

Au démarrage, le serveur recharge tout depuis Upstash ; chaque changement y est sauvegardé en 1 à 2 secondes.
