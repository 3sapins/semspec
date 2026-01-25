# 🎯 Semaine Spéciale - Collège des Trois-Sapins

Plateforme de gestion des ateliers pour la Semaine Spéciale du Collège des Trois-Sapins, Echallens (Suisse).

## 📋 Fonctionnalités

- **Administration** : Gestion des enseignants, élèves, salles et créneaux
- **Ateliers** : Création, validation et planification des ateliers
- **Inscriptions** : Système d'inscription pour les élèves avec gestion des quotas
- **Planning** : Allocation automatique ou manuelle des ateliers
- **Présences** : Pointage des élèves pendant la semaine spéciale
- **Impressions** : Génération de listes et badges

## 🚀 Installation rapide

### Prérequis

- Node.js >= 18
- MySQL ou MariaDB
- Git

### Étapes

```bash
# 1. Cloner le dépôt
git clone https://github.com/VOTRE_USERNAME/semaine-speciale.git
cd semaine-speciale

# 2. Installer les dépendances
npm install

# 3. Configurer l'environnement
cp .env.example .env
# Éditer .env avec vos paramètres

# 4. Créer la base de données
mysql -u root -p -e "CREATE DATABASE semaine_speciale CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p -e "CREATE USER 'semaine_user'@'localhost' IDENTIFIED BY 'VOTRE_MOT_DE_PASSE';"
mysql -u root -p -e "GRANT ALL PRIVILEGES ON semaine_speciale.* TO 'semaine_user'@'localhost';"

# 5. Initialiser le schéma
mysql -u root -p semaine_speciale < schema_mysql.sql

# 6. Démarrer
npm start
```

### Accès

- **URL** : http://localhost:3001
- **Admin** : `admin` / `SemaineSpeciale2026!`

## 📁 Structure du projet

```
semaine-speciale/
├── public/              # Interface web (HTML/CSS/JS)
│   ├── login.html       # Page de connexion
│   ├── index.html       # Dashboard admin
│   ├── enseignants.html # Espace enseignants
│   ├── eleves.html      # Espace élèves
│   └── ...
├── src/
│   ├── server.js        # Point d'entrée
│   ├── config/
│   │   └── database.js  # Configuration MySQL
│   ├── middleware/
│   │   └── auth.js      # Authentification JWT
│   └── routes/
│       ├── admin.js     # Routes administration
│       ├── auth.js      # Routes authentification
│       ├── enseignants.js
│       ├── eleves.js
│       ├── planning.js
│       ├── gestion.js
│       ├── presence.js
│       └── print.js
├── uploads/             # Fichiers uploadés (CSV)
├── schema_mysql.sql     # Schéma de la base de données
├── .env.example         # Template de configuration
├── package.json
└── README.md
```

## 🔧 Configuration (.env)

```env
# Base de données
DB_HOST=localhost
DB_USER=semaine_user
DB_PASSWORD=votre_mot_de_passe
DB_NAME=semaine_speciale

# Serveur
PORT=3001
NODE_ENV=production

# JWT
JWT_SECRET=une_cle_secrete_longue_et_aleatoire
JWT_EXPIRES_IN=24h
```

## 👥 Rôles utilisateurs

| Rôle | Accès | Identifiant |
|------|-------|-------------|
| Admin | Gestion complète | `admin` |
| Enseignant | Création d'ateliers, pointage | Acronyme (ex: `DUP`) |
| Élève | Inscription aux ateliers | prénomnom (ex: `lucasalleman`) |

## 📊 Workflow type

1. **Préparation** (Admin)
   - Import des enseignants, élèves et salles via CSV
   - Configuration des créneaux

2. **Création** (Enseignants)
   - Les enseignants créent leurs ateliers
   - Définition des places, durée, besoins

3. **Validation** (Admin)
   - Validation des ateliers
   - Allocation dans le planning

4. **Inscriptions** (Élèves)
   - Ouverture des inscriptions par classe
   - Les élèves s'inscrivent aux ateliers

5. **Semaine Spéciale**
   - Pointage des présences
   - Gestion des absences

## 🛠️ Commandes utiles

```bash
# Développement (avec rechargement auto)
npm run dev

# Production
npm start

# Voir les logs (si PM2)
pm2 logs semaine-speciale
```

## 📝 Import CSV

### Enseignants
```csv
acronyme,nom,prenom,email,charge_max
DUP,Dupont,Marie,marie@ecole.ch,20
```

### Élèves
```csv
nom,prenom,classe_nom
Alleman,Lucas,9VP1
```

### Salles
```csv
nom,type_salle,capacite
A101,standard,25
Gym,sport,60
```

## 🔒 Sécurité

- Mots de passe hashés avec bcrypt
- Authentification par JWT
- Middleware de vérification des rôles
- Protection CORS

## 📄 Licence

MIT - Libre d'utilisation et de modification.

---

Développé pour le Collège des Trois-Sapins, Echallens 🇨🇭
