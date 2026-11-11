# Ma liste de courses

Une liste de courses **partagée par un simple lien**, sans compte ni installation.
Deux personnes ajoutent, modifient, cochent et suppriment les articles — les deux téléphones
restent synchronisés en direct (Server-Sent Events).

- **Accueil** → un bouton « Créer une liste » ouvre immédiatement une liste vide.
- **Ajout en haut de l’écran** : « Lait », ou « Pommes » + quantité « 4 ».
- **Lien de partage** copié en un appui ; la personne qui l’ouvre arrive sur la même liste.
- **Deux sections** : « À acheter » puis « Achetés » (un article coché descend, décoché il remonte).
- **Sous-catégories** : chaque article peut être rangé sous un repas ou un rayon
  (« Repas du lundi », « Dessert »…), créé à la volée depuis le bouton **Catégorie**.
  Les deux sections « À acheter » et « Achetés » sont alors regroupées par catégorie.
- **Barre de progression** : « 2 sur 5 achetés » et état de synchronisation en direct.
- **Modification / suppression** via la feuille de détail d’un article, avec **Annuler** après suppression.
- **Thème clair ou sombre** : bouton dans l’en-tête, choix mémorisé, mode système suivi par défaut.
- **Temps réel** : chaque modification est poussée aux autres appareils, sans rechargement.
- **Mise à jour optimiste** : l’écran réagit tout de suite ; en cas d’échec réseau, la modification
  est annulée et un message clair propose **Réessayer**.
- **Partage natif** : sur mobile, le bouton « Partager » ouvre la feuille de partage du téléphone ;
  le bouton principal copie le lien et confirme par « Lien copié ».
- **Raccourci `/`** sur ordinateur : place le curseur dans le champ d’ajout.

---

## 1. Stack et structure

| Élément | Choix |
|---|---|
| Serveur | Node.js 20+ / Express 4 |
| Base de données | PostgreSQL (production), fichier JSON local (aperçu / développement) |
| Temps réel | Server-Sent Events (`/api/lists/:id/events`) |
| Frontend | HTML + CSS + JavaScript natifs, mobile‑first, thèmes clair/sombre, aucune étape de build |
| Déploiement | Railway (Dockerfile fourni), compatible tout hébergeur Node |

```
.
├── server.js            # API REST + temps réel + stockage (PostgreSQL ou fichier)
├── public/
│   ├── index.html       # accueil + écran de liste
│   ├── styles.css       # thèmes clair/sombre, couleur d’accent unique, cibles tactiles 48 px
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
items (id text pk, list_id → lists, name, quantity, done bool,
       category text not null default '', created_at, updated_at)
```

La colonne `category` est ajoutée automatiquement aux bases existantes
(`ALTER TABLE items ADD COLUMN IF NOT EXISTS category …`) : aucune migration manuelle.

L’identifiant d’une liste est un jeton aléatoire de 12 octets encodé en base64url
(16 caractères, ~96 bits d’entropie) : impossible à deviner. Le lien `/l/<jeton>` fait office
de mot de passe : **toute personne qui possède le lien peut modifier la liste**.


## 2. Sous-catégories (repas, rayons…)

Pour une liste organisée « par repas », chaque article possède une catégorie libre
(60 caractères maximum).

- Le bouton **Catégorie** du formulaire d’ajout ouvre une feuille qui liste les catégories
  déjà utilisées, avec le nombre d’articles de chacune, et permet d’en saisir une nouvelle.
- La catégorie choisie reste active pour les articles suivants : on enchaîne les ajouts du
  même repas. Elle est mémorisée par liste dans le navigateur (`mlc:category:<id>`).
- Dès qu’au moins un article est classé, « À acheter » et « Achetés » sont découpés en
  sous-groupes ; les articles non classés apparaissent en tête sous « Sans catégorie ».
- La feuille d’édition d’un article permet de changer sa catégorie (champ avec suggestions).
- Une catégorie disparaît d’elle-même quand elle ne contient plus d’article.
- Les noms sont comparés sans tenir compte de la casse : « repas du lundi » réutilise
  « Repas du lundi » existant.

## 3. Thème clair / sombre

L’interface utilise deux jeux de variables CSS (`:root` pour le clair, `:root[data-theme="dark"]`
pour le sombre) : fonds, surfaces, bordures, texte et couleur d’accent sont tous dérivés de jetons,
avec une couleur d’accent unique par thème (vert profond en clair, vert menthe en sombre).

- Au premier chargement, le thème suit `prefers-color-scheme`.
- Un script inline applique le thème **avant le premier rendu** : aucun flash blanc.
- Le bouton (soleil/lune, avec le libellé « Sombre »/« Clair » sur écran large) bascule et
  mémorise le choix (`localStorage`, clé `mlc:theme`).
- Ce script est **autonome** : il gère lui-même le clic, sans dépendre de `app.js`.
  Un ancien `app.js` en cache ne peut donc plus casser le bouton.
- Tant qu’aucun choix explicite n’a été fait, un changement de thème du système est suivi.
- `?theme=dark` ou `?theme=light` force un thème (utile si le stockage local est bloqué,
  par exemple dans une iframe restreinte).
- `color-scheme` et `<meta name="theme-color">` sont mis à jour pour les barres du navigateur.
- Les fichiers `styles.css` et `app.js` sont chargés avec un paramètre de version
  (`?v=…`) et servis en `Cache-Control: no-cache` : après une mise à jour, le navigateur
  récupère bien la nouvelle version. **Incrémentez ce paramètre** dans `public/index.html`
  à chaque modification du CSS ou du JS.

---

## 4. Lancer en local

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

## 5. Déployer sur Railway — pas à pas

### 5.1 Mettre le code sur GitHub

```bash
git add .
git commit -m "Ma liste de courses"
git push origin main
```

### 5.2 Créer le projet et l’application

1. Connectez-vous sur [railway.app](https://railway.app) → **New Project**.
2. **Deploy from GitHub repo** → choisissez ce dépôt.
3. Railway détecte le `Dockerfile` et lance le build. (Sinon : **Settings → Build →
   Builder = Dockerfile**, et **Deploy → Start Command = `node server.js`**.)

### 5.3 Créer la base de données

1. Dans le projet : **New → Database → Add PostgreSQL**.
   Railway crée un service `Postgres` avec sa propre variable `DATABASE_URL`.
2. Attendez que le service soit en état **Active**.

### 5.4 Configurer les variables d’environnement

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

### 5.5 Obtenir l’adresse publique

1. Service application → **Settings → Networking → Public Networking → Generate Domain**.
2. Railway fournit une URL du type `https://ma-liste-production.up.railway.app`.
   L’application est servie sur `/`, les liens partagés sur `/l/<jeton>`.
3. Vérifiez la santé du service : `https://<votre-domaine>/api/health` doit renvoyer
   `"databaseConfigured": true`.

### 5.6 Vérifier le partage

Sur un premier téléphone : ouvrez `https://<votre-domaine>/`, **Créer une liste**, ajoutez
« Pommes » quantité « 4 », **Copier le lien de partage**.
Sur un second téléphone : ouvrez ce lien, l’article est déjà là. Cochez-le sur l’un, il passe
dans « Achetés » sur l’autre sans rechargement. Fermez les deux pages, rouvrez le lien :
la liste est dans son dernier état, base PostgreSQL à l’appui.

---

## 6. Aperçu Arena : ce qui marche, ce qui ne marche pas

L’aperçu Arena exécute l’application **sans accès à une base PostgreSQL**. Dans ce cas :

- l’application **le signale en haut de l’écran** (« Aperçu : base de données non connectée »)
  et propose le détail de la configuration ;
- les listes sont enregistrées dans `data/store.json` **sur le serveur d’aperçu** : le partage
  entre deux navigateurs y fonctionne, mais les données peuvent disparaître au redémarrage du
  conteneur (système de fichiers éphémère) ;
- `GET /api/health` renvoie `"storage": "file"` et le message d’explication.

**Aucun code n’est à modifier** pour activer le partage durable : dès que la variable
`DATABASE_URL` est présente (étape 5.4), le serveur bascule automatiquement sur PostgreSQL,
crée les tables et affiche « Synchronisé ». Le bandeau d’avertissement disparaît de lui-même.

---

## 7. API (si vous voulez brancher un autre client)

| Méthode | Route | Corps | Effet |
|---|---|---|---|
| `POST` | `/api/lists` | — | Crée une liste, renvoie `{ list }` avec son `id` secret |
| `GET` | `/api/lists/:id` | — | Liste complète + `revision` |
| `GET` | `/api/lists/:id/events` | — | Flux SSE : événements `list` à chaque modification |
| `POST` | `/api/lists/:id/items` | `{ "name": "Pommes", "quantity": "4", "category": "Repas du lundi" }` | Ajoute un article |
| `PATCH` | `/api/lists/:id/items/:itemId` | `{ "name"?, "quantity"?, "category"?, "done"? }` | Modifie / coche / décoche |
| `DELETE` | `/api/lists/:id/items/:itemId` | — | Supprime |
| `GET` | `/api/health` | — | État du service et mode de stockage |

Chaque réponse contient la liste à jour (`revision` incrémentée), ce qui permet aux clients de
recaler leur affichage. Limites : 120 caractères pour le nom, 40 pour la quantité, 60 pour la catégorie,
300 articles par liste.

---

## 8. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Bandeau « base de données non connectée » en production | `DATABASE_URL` absente ou mal référencée | Variables → `DATABASE_URL = ${{Postgres.DATABASE_URL}}`, puis **Redeploy** |
| Logs : `Connexion PostgreSQL impossible` | Base pas encore prête, ou SSL | Attendre la fin du déploiement de Postgres ; le serveur retente 5 fois. Vérifiez le nom du service dans la référence `${{…}}` |
| `password authentication failed` | URL modifiée à la main | Supprimez la variable et recréez la référence `${{Postgres.DATABASE_URL}}` |
| Le déploiement reste « unhealthy » | Le port n’est pas `PORT` | Ne définissez pas `PORT` manuellement, Railway l’injecte |
| Rien ne se synchronise entre deux téléphones | Proxy qui bufferise le SSE | L’application bascule automatiquement sur une interrogation toutes les 6 s ; vérifiez l’indicateur « Synchronisé » |
| Le bouton de thème ne change rien | Ancien CSS/JS gardé en cache | Rechargez la page (voire videz le cache). Les fichiers sont désormais versionnés (`?v=…`) et le clic est géré par le script inline. Test de contrôle : ouvrez `?theme=dark` |
| Lien perdu | — | Les liens ne sont pas listés publiquement : utilisez « Reprendre ma dernière liste » sur l’accueil du même navigateur |

---

## 9. Sécurité et vie privée

- Pas de compte, pas de cookie de suivi, pas de service tiers : tout est stocké dans votre base.
- Le lien est un jeton aléatoire non énumérable ; il n’est jamais indexé ni exposé par une route
  de liste. Ne le partagez qu’avec les personnes concernées : il vaut autorisation d’écriture.
- Les entrées sont validées et limitées côté serveur ; le nom est échappé côté client (pas
  d’injection HTML), et les requêtes SQL sont entièrement paramétrées.
- Pour révoquer l’accès, supprimez la liste en base (`DELETE FROM lists WHERE id = '…'`, les
  articles suivent via `ON DELETE CASCADE`).
