# AgentControl – Contrôle des agents & Points de Relais

Application web (PWA) pour gérer la présence des agents sur plusieurs points de relais.

## Mode serveur = accès mondial

| Mode | Quand | Où sont les données |
|------|--------|---------------------|
| **Serveur** (recommandé) | Vous lancez `node server.js` ou hébergez en ligne | Fichier `data/store.json` **sur le serveur** — partagé entre tous les utilisateurs |
| **Local** (secours) | Ouverture du simple `index.html` sans serveur Node | Navigateur (IndexedDB + localStorage) — **par appareil uniquement** |

Avec le serveur hébergé en ligne :
- les agents pointent depuis n’importe où ;
- l’**admin consulte tous les mouvements** (pointages, historique, rapports) **depuis n’importe quel pays / appareil** ;
- les pointages faits hors-ligne sont resynchronisés dès que le réseau revient ;
- le tableau de bord admin se rafraîchit automatiquement toutes les 45 s.

> **Important** : ouvrir seulement `index.html` en double-clic = mode local. Pour un site accessible dans le monde entier, il faut **héberger** le serveur Node.

---

## Démarrage local (test avec enregistrement sur le site)

Prérequis : Node.js 16+

```bash
cd dossier-agentcontrol
node server.js
```

Ouvrez **http://localhost:8080**  
Les données sont écrites dans `data/store.json`.  
Le serveur écoute sur **0.0.0.0** (accessible aussi depuis d’autres appareils du même réseau : `http://IP-locale:8080`).

---

## Hébergement public (admin + agents dans le monde entier)

### Option A — VPS / machine avec Node.js (recommandé)

1. Copiez tout le dossier sur le serveur
2. Installez Node.js si besoin
3. Lancez :

```bash
node server.js
```

4. Production avec PM2 :

```bash
npm install -g pm2
pm2 start server.js --name agentcontrol
pm2 save
pm2 startup
```

5. Reverse proxy Nginx (HTTPS) vers le port `8080` si besoin.

Variable optionnelle : `PORT=3000 node server.js`

Ouvrez l’URL publique de votre VPS → badge **Serveur** dans l’app. L’admin voit alors tous les mouvements où qu’il se trouve.

### Option B — Railway, Render, Fly.io, etc. (gratuit / simple)

- **Commande de démarrage** : `node server.js` (ou `npm start`)
- Racine du projet = ce dossier
- **Persistez le volume / dossier `data/`** pour ne pas perdre `store.json` au redémarrage
- Port : la plateforme injecte souvent `PORT` (le serveur le lit automatiquement)

Fichiers inclus pour faciliter le déploiement :
- `Procfile` (Heroku / Railway)
- `render.yaml` (Render)

Après déploiement, partagez l’URL HTTPS fournie par la plateforme. Agents et admin se connectent depuis n’importe quel navigateur dans le monde.

### Attention

- Mode local (fichier ouvert en double-clic) = données **uniquement sur ce téléphone / PC**.
- En production, **changez les mots de passe** admin / agents par défaut.
- Pour HTTPS (caméra QR sur mobile), un certificat valide est nécessaire (fourni par Railway/Render/Nginx).

---

## Fonctionnalités

- Codes QR par point de relais + scan caméra
- Pointage agent (QR ou manuel), GPS optionnel, photo compressée
- Admin : tableau de bord, points, agents, historique, rapports, export CSV
- Mode hors-ligne : cache local ; resynchronisation automatique quand le serveur est joignable
- Rafraîchissement live admin (45 s) des mouvements en mode serveur

## Comptes par défaut

| Rôle  | Identifiant | Mot de passe |
|-------|-------------|--------------|
| Admin | admin       | admin123     |
| Agent | agent1      | agent123     |
| Agent | agent2      | agent123     |

## API (serveur)

| Méthode | URL | Description |
|---------|-----|-------------|
| GET | `/api/health` | Statut serveur |
| GET | `/api/data` | Tout le store |
| GET | `/api/data/:key` | users, points, checkins, assignments |
| PUT | `/api/data/:key` | Remplace une collection |
| POST | `/api/checkins` | Ajoute un pointage (atomique) |

## Format QR

`AGENTCONTROL|POINT|{id_du_point}`
