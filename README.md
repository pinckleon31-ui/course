# Ma liste de courses

Une liste de courses **partagée par un simple lien**, sans compte ni installation.
Deux personnes ajoutent, modifient, cochent et suppriment les articles — les deux téléphones
restent synchronisés en direct (Server-Sent Events).

- **Accueil** → un bouton « Créer une liste » ouvre immédiatement une liste vide.
- **Ajout en haut de l’écran** : « Lait », ou « Pommes » + quantité « 4 ».
- **Lien de partage** copié en un appui ; la personne qui l’ouvre arrive sur la même liste.
- **Deux sections** : « À acheter » puis « Achetés » (un article coché descend, décoché il remonte).
- **Modification / suppression** via la feuille de détail d’un article.
- **Temps réel** : chaque modification est poussée aux autres appareils, sans rechargement.
- **Mise à jour optimiste** : l’écran réagit tout de suite ; en cas d’échec réseau, la modification
  est annulée et un message clair propose **Réessayer**.

---

## 1. Stack et structure

| Élément | Choix |
|---|---|
| Serveur | Node.js 20+ / Express 4 |
| Base de données | PostgreSQL (production), fichier JSON local (aperçu / développement) |
| Temps réel | Server-Sent Events (`/api/lists/:id/events`) |
| Frontend | HTML + CSS + JavaScript natifs, mobile‑first, aucune étape de build |
| Déploiement | Railway (Dockerfile fourni), compatible tout hébergeur Node |

```
.
├── server.js            # API REST + temps réel + stockage (PostgreSQL ou fichier)
├── public/
│   ├── index.html       # accueil + écran de liste
│   ├── styles.css       # thème clair, couleur d’accent unique, cibles tactiles 48 px
│   ├── app.js           # logique client, synchronisation, mises à jour optimistes
│   └── 404.html
├── Dockerfile
├── railway.toml
├── .env.example
└── package.json
```

Le schéma de base est créé automatiquement au démarrage (`CREATE TABLE IF NOT EXISTS`) :
aucune migration à lancer à la main.

```sql
lists (id text pk, revision int, created_at, updated_at)
items (id text pk, list_id → lists, name, quantity, done bool, created_at, updated_at)
```

L’identifiant d’une liste est un jeton aléatoire de 12 octets encodé en base64url
(16 caractères, ~96 bits d’entropie) : impossible à deviner. Le lien `/l/<jeton>` fait office
de mot de passe : **toute personne qui possède le lien peut modifier la liste**.

---

## 2. Lancer en local

```bash
npm install
npm start
# → http://localhost:8080
```

Sans variable `DATABASE_URL`, les données sont écrites dans `data/store.json` (pratique pour
tester le partage entre deux onglets ou deux appareils du même réseau). Pour utiliser
PostgreSQL en local :

```bash
cp .env.example .env
# éditez DATABASE_URL, puis :
export $(grep -v '^#' .env | xargs)   # ou utilisez dotenv/ votre gestionnaire habituel
npm start
```

`GET /api/health` indique le mode de stockage actif :

```json
{ "ok": true, "storage": "postgres", "databaseConfigured": true, "warning": null }
```

---

## 3. Déployer sur Railway — pas à pas

### 3.1 Mettre le code sur GitHub

```bash
git add .
git commit -m "Ma liste de courses"
git push origin main
```

### 3.2 Créer le projet et l’application

1. Connectez-vous sur [railway.app](https://railway.app) → **New Project**.
2. **Deploy from GitHub repo** → choisissez ce dépôt.
3. Railway détecte le `Dockerfile` et lance le build. (Sinon : **Settings → Build →
   Builder = Dockerfile**, et **Deploy → Start Command = `node server.js`**.)

### 3.3 Créer la base de données

1. Dans le projet : **New → Database → Add PostgreSQL**.
   Railway crée un service `Postgres` avec sa propre variable `DATABASE_URL`.
2. Attendez que le service soit en état **Active**.

### 3.4 Configurer les variables d’environnement

Ouvrez le service de **l’application** (pas la base) → onglet **Variables** → **New Variable** :

| Nom | Valeur | Rôle |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Connexion à la base (référence interne Railway) |
| `NODE_ENV` | `production` | Mode production |
| `PORT` | *(ne pas définir)* | Railway l’injecte automatiquement |

> La syntaxe `${{Postgres.DATABASE_URL}}` est une référence de variable Railway : elle se résout
> automatiquement vers l’URL interne du service PostgreSQL. Si votre service de base porte un
> autre nom, utilisez `${{<NomDuService>.DATABASE_URL}}`.
>
> Pour une connexion depuis l’extérieur (administration, `psql` local), utilisez plutôt
> `DATABASE_PUBLIC_URL` du service Postgres. L’application accepte les deux : le SSL est activé
> automatiquement pour les URL publiques et désactivé pour `*.railway.internal` et `localhost`.

Après l’ajout de `DATABASE_URL`, Railway redéploie automatiquement. Au démarrage, le serveur
attend la base (jusqu’à 5 tentatives) et crée les tables. Les logs affichent :

```
[store] PostgreSQL connecté — partage actif entre les appareils.
```

### 3.5 Obtenir l’adresse publique

1. Service application → **Settings → Networking → Public Networking → Generate Domain**.
2. Railway fournit une URL du type `https://ma-liste-production.up.railway.app`.
   L’application est servie sur `/`, les liens partagés sur `/l/<jeton>`.
3. Vérifiez la santé du service : `https://<votre-domaine>/api/health` doit renvoyer
   `"databaseConfigured": true`.

### 3.6 Vérifier le partage

Sur un premier téléphone : ouvrez `https://<votre-domaine>/`, **Créer une liste**, ajoutez
« Pommes » quantité « 4 », **Copier le lien de partage**.
Sur un second téléphone : ouvrez ce lien, l’article est déjà là. Cochez-le sur l’un, il passe
dans « Achetés » sur l’autre sans rechargement. Fermez les deux pages, rouvrez le lien :
la liste est dans son dernier état, base PostgreSQL à l’appui.

---

## 4. Aperçu Arena : ce qui marche, ce qui ne marche pas

L’aperçu Arena exécute l’application **sans accès à une base PostgreSQL**. Dans ce cas :

- l’application **le signale en haut de l’écran** (« Aperçu : base de données non connectée »)
  et propose le détail de la configuration ;
- les listes sont enregistrées dans `data/store.json` **sur le serveur d’aperçu** : le partage
  entre deux navigateurs y fonctionne, mais les données peuvent disparaître au redémarrage du
  conteneur (système de fichiers éphémère) ;
- `GET /api/health` renvoie `"storage": "file"` et le message d’explication.

**Aucun code n’est à modifier** pour activer le partage durable : dès que la variable
`DATABASE_URL` est présente (étape 3.4), le serveur bascule automatiquement sur PostgreSQL,
crée les tables et affiche « Synchronisé ». Le bandeau d’avertissement disparaît de lui-même.

---

## 5. API (si vous voulez brancher un autre client)

| Méthode | Route | Corps | Effet |
|---|---|---|---|
| `POST` | `/api/lists` | — | Crée une liste, renvoie `{ list }` avec son `id` secret |
| `GET` | `/api/lists/:id` | — | Liste complète + `revision` |
| `GET` | `/api/lists/:id/events` | — | Flux SSE : événements `list` à chaque modification |
| `POST` | `/api/lists/:id/items` | `{ "name": "Pommes", "quantity": "4" }` | Ajoute un article |
| `PATCH` | `/api/lists/:id/items/:itemId` | `{ "name"?, "quantity"?, "done"? }` | Modifie / coche / décoche |
| `DELETE` | `/api/lists/:id/items/:itemId` | — | Supprime |
| `GET` | `/api/health` | — | État du service et mode de stockage |

Chaque réponse contient la liste à jour (`revision` incrémentée), ce qui permet aux clients de
recaler leur affichage. Limites : 120 caractères pour le nom, 40 pour la quantité, 300 articles
par liste.

---

## 6. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Bandeau « base de données non connectée » en production | `DATABASE_URL` absente ou mal référencée | Variables → `DATABASE_URL = ${{Postgres.DATABASE_URL}}`, puis **Redeploy** |
| Logs : `Connexion PostgreSQL impossible` | Base pas encore prête, ou SSL | Attendre la fin du déploiement de Postgres ; le serveur retente 5 fois. Vérifiez le nom du service dans la référence `${{…}}` |
| `password authentication failed` | URL modifiée à la main | Supprimez la variable et recréez la référence `${{Postgres.DATABASE_URL}}` |
| Le déploiement reste « unhealthy » | Le port n’est pas `PORT` | Ne définissez pas `PORT` manuellement, Railway l’injecte |
| Rien ne se synchronise entre deux téléphones | Proxy qui bufferise le SSE | L’application bascule automatiquement sur une interrogation toutes les 6 s ; vérifiez l’indicateur « Synchronisé » |
| Lien perdu | — | Les liens ne sont pas listés publiquement : utilisez « Reprendre ma dernière liste » sur l’accueil du même navigateur |

---

## 7. Sécurité et vie privée

- Pas de compte, pas de cookie de suivi, pas de service tiers : tout est stocké dans votre base.
- Le lien est un jeton aléatoire non énumérable ; il n’est jamais indexé ni exposé par une route
  de liste. Ne le partagez qu’avec les personnes concernées : il vaut autorisation d’écriture.
- Les entrées sont validées et limitées côté serveur ; le nom est échappé côté client (pas
  d’injection HTML), et les requêtes SQL sont entièrement paramétrées.
- Pour révoquer l’accès, supprimez la liste en base (`DELETE FROM lists WHERE id = '…'`, les
  articles suivent via `ON DELETE CASCADE`).
