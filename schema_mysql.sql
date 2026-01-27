-- ============================================
-- SCHÉMA MYSQL - PLATEFORME SEMAINE SPÉCIALE v5.3
-- Collège des Trois-Sapins - Echallens
-- Compatible MySQL 8+ et MariaDB 10.5+
-- ============================================

SET FOREIGN_KEY_CHECKS = 0;
SET NAMES utf8mb4;

-- ============================================
-- TABLES DE BASE
-- ============================================

-- Table des utilisateurs (admin, enseignants ET élèves)
CREATE TABLE IF NOT EXISTS utilisateurs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    acronyme VARCHAR(20) UNIQUE NOT NULL,
    nom VARCHAR(100) NOT NULL,
    prenom VARCHAR(100) NOT NULL,
    email VARCHAR(150),
    mot_de_passe VARCHAR(255) NOT NULL,
    role ENUM('admin', 'enseignant', 'eleve') NOT NULL DEFAULT 'enseignant',
    charge_max INT DEFAULT 0 COMMENT 'Périodes enseignées (enseignants uniquement)',
    actif BOOLEAN DEFAULT TRUE,
    date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    derniere_connexion TIMESTAMP NULL,
    INDEX idx_acronyme (acronyme),
    INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des classes
CREATE TABLE IF NOT EXISTS classes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nom VARCHAR(20) UNIQUE NOT NULL,
    niveau VARCHAR(10) NOT NULL,
    voie ENUM('VP', 'VG', 'RAC') NOT NULL,
    annee INT NOT NULL,
    nombre_eleves INT DEFAULT 0,
    inscriptions_ouvertes BOOLEAN DEFAULT TRUE,
    INDEX idx_nom (nom)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table de liaison élèves-classes
CREATE TABLE IF NOT EXISTS eleves (
    id INT AUTO_INCREMENT PRIMARY KEY,
    utilisateur_id INT NOT NULL,
    classe_id INT NOT NULL,
    numero_eleve VARCHAR(20),
    FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE CASCADE,
    FOREIGN KEY (classe_id) REFERENCES classes(id) ON DELETE CASCADE,
    INDEX idx_classe (classe_id),
    INDEX idx_utilisateur (utilisateur_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des salles
CREATE TABLE IF NOT EXISTS salles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nom VARCHAR(50) UNIQUE NOT NULL,
    capacite INT NOT NULL DEFAULT 25,
    type_salle VARCHAR(50),
    equipement TEXT,
    batiment VARCHAR(50),
    disponible BOOLEAN DEFAULT TRUE,
    INDEX idx_nom (nom)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLES TEMPORELLES
-- ============================================

-- Table des créneaux horaires
CREATE TABLE IF NOT EXISTS creneaux (
    id INT AUTO_INCREMENT PRIMARY KEY,
    jour ENUM('lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi') NOT NULL,
    periode VARCHAR(20) NOT NULL,
    heure_debut TIME NOT NULL,
    heure_fin TIME NOT NULL,
    ordre INT NOT NULL,
    actif BOOLEAN DEFAULT TRUE,
    INDEX idx_jour (jour),
    INDEX idx_ordre (ordre),
    UNIQUE KEY unique_jour_periode (jour, periode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLES DES ATELIERS
-- ============================================

-- Table des ateliers
-- Table des thèmes d'ateliers
CREATE TABLE IF NOT EXISTS themes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nom VARCHAR(100) NOT NULL,
    description TEXT,
    couleur VARCHAR(7) DEFAULT '#667eea' COMMENT 'Code couleur hex',
    icone VARCHAR(10) DEFAULT '📚' COMMENT 'Emoji',
    ordre INT DEFAULT 0,
    actif BOOLEAN DEFAULT TRUE,
    UNIQUE KEY unique_nom (nom)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insérer quelques thèmes par défaut
INSERT IGNORE INTO themes (nom, description, couleur, icone, ordre) VALUES
('Sport & Mouvement', 'Activités sportives et physiques', '#ef4444', '⚽', 1),
('Arts & Créativité', 'Arts visuels, musique, théâtre', '#8b5cf6', '🎨', 2),
('Sciences & Technologie', 'Expériences, informatique, robotique', '#3b82f6', '🔬', 3),
('Culture & Société', 'Histoire, langues, citoyenneté', '#f59e0b', '🌍', 4),
('Nature & Environnement', 'Écologie, jardinage, animaux', '#22c55e', '🌿', 5),
('Bien-être & Développement', 'Relaxation, cuisine, compétences de vie', '#ec4899', '🧘', 6),
('Jeux & Loisirs', 'Jeux de société, escape games', '#06b6d4', '🎲', 7);

CREATE TABLE IF NOT EXISTS ateliers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nom VARCHAR(200) NOT NULL,
    description TEXT,
    enseignant_acronyme VARCHAR(20) NOT NULL,
    enseignant2_acronyme VARCHAR(20) DEFAULT NULL,
    enseignant3_acronyme VARCHAR(20) DEFAULT NULL,
    theme_id INT DEFAULT NULL,
    duree INT NOT NULL DEFAULT 2 COMMENT 'En périodes: 2, 4 ou 6',
    nombre_places_max INT NOT NULL DEFAULT 20,
    budget_max DECIMAL(10,2) DEFAULT 0,
    type_salle_demande VARCHAR(50),
    remarques TEXT,
    informations_eleves TEXT,
    statut ENUM('brouillon', 'soumis', 'valide', 'refuse', 'annule') DEFAULT 'brouillon',
    obligatoire BOOLEAN DEFAULT FALSE,
    date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_modification TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_enseignant (enseignant_acronyme),
    INDEX idx_statut (statut),
    INDEX idx_theme (theme_id),
    FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des ateliers obligatoires par classe
CREATE TABLE IF NOT EXISTS ateliers_obligatoires (
    id INT AUTO_INCREMENT PRIMARY KEY,
    atelier_id INT NOT NULL,
    classe_id INT NOT NULL,
    FOREIGN KEY (atelier_id) REFERENCES ateliers(id) ON DELETE CASCADE,
    FOREIGN KEY (classe_id) REFERENCES classes(id) ON DELETE CASCADE,
    UNIQUE KEY unique_atelier_classe (atelier_id, classe_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLES DE PLANNING
-- ============================================

-- Table du planning (allocation des ateliers)
CREATE TABLE IF NOT EXISTS planning (
    id INT AUTO_INCREMENT PRIMARY KEY,
    atelier_id INT NOT NULL,
    salle_id INT,
    creneau_id INT NOT NULL,
    nombre_creneaux INT NOT NULL DEFAULT 1,
    valide BOOLEAN DEFAULT FALSE,
    date_allocation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (atelier_id) REFERENCES ateliers(id) ON DELETE CASCADE,
    FOREIGN KEY (salle_id) REFERENCES salles(id) ON DELETE SET NULL,
    FOREIGN KEY (creneau_id) REFERENCES creneaux(id) ON DELETE CASCADE,
    INDEX idx_atelier (atelier_id),
    INDEX idx_salle (salle_id),
    INDEX idx_creneau (creneau_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLES D'INSCRIPTIONS
-- ============================================

-- Table des inscriptions élèves
CREATE TABLE IF NOT EXISTS inscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    eleve_id INT NOT NULL,
    atelier_id INT NOT NULL,
    date_inscription TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    statut ENUM('en_attente', 'confirmee', 'annulee') DEFAULT 'confirmee',
    inscription_manuelle BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (eleve_id) REFERENCES eleves(id) ON DELETE CASCADE,
    FOREIGN KEY (atelier_id) REFERENCES ateliers(id) ON DELETE CASCADE,
    UNIQUE KEY unique_eleve_atelier (eleve_id, atelier_id),
    INDEX idx_eleve (eleve_id),
    INDEX idx_atelier (atelier_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLES PIQUET ET PRÉSENCES
-- ============================================

-- Table enseignants de piquet/dégagement
CREATE TABLE IF NOT EXISTS enseignants_piquet (
    id INT AUTO_INCREMENT PRIMARY KEY,
    utilisateur_id INT NOT NULL,
    creneau_id INT NOT NULL,
    type ENUM('piquet', 'degagement') NOT NULL DEFAULT 'piquet',
    commentaire TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE CASCADE,
    FOREIGN KEY (creneau_id) REFERENCES creneaux(id) ON DELETE CASCADE,
    UNIQUE KEY unique_ens_creneau (utilisateur_id, creneau_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des présences
CREATE TABLE IF NOT EXISTS presences (
    id INT AUTO_INCREMENT PRIMARY KEY,
    atelier_id INT NOT NULL,
    eleve_id INT NOT NULL,
    creneau_id INT NOT NULL,
    statut ENUM('present', 'absent', 'non_pointe') DEFAULT 'non_pointe',
    valide_par VARCHAR(20),
    valide_le TIMESTAMP NULL,
    commentaire VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (atelier_id) REFERENCES ateliers(id) ON DELETE CASCADE,
    FOREIGN KEY (eleve_id) REFERENCES eleves(id) ON DELETE CASCADE,
    FOREIGN KEY (creneau_id) REFERENCES creneaux(id) ON DELETE CASCADE,
    UNIQUE KEY unique_presence (atelier_id, eleve_id, creneau_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE DE CONFIGURATION
-- ============================================

CREATE TABLE IF NOT EXISTS configuration (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cle VARCHAR(100) UNIQUE NOT NULL,
    valeur TEXT,
    description TEXT,
    date_modification TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE HISTORIQUE
-- ============================================

CREATE TABLE IF NOT EXISTS historique (
    id INT AUTO_INCREMENT PRIMARY KEY,
    utilisateur_id INT,
    action VARCHAR(100) NOT NULL,
    table_cible VARCHAR(50),
    id_cible INT,
    details TEXT,
    date_action TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
    INDEX idx_date (date_action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE DISPONIBILITÉS ENSEIGNANTS
-- ============================================

CREATE TABLE IF NOT EXISTS disponibilites_enseignants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    enseignant_acronyme VARCHAR(20) NOT NULL,
    creneau_id INT NOT NULL,
    disponible BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (creneau_id) REFERENCES creneaux(id) ON DELETE CASCADE,
    UNIQUE KEY unique_ens_creneau (enseignant_acronyme, creneau_id),
    INDEX idx_enseignant (enseignant_acronyme)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- VUE PLANNING MULTI-BLOCS
-- ============================================

CREATE VIEW vue_planning_multiblocs AS
SELECT 
    p.id as planning_id,
    p.atelier_id,
    p.salle_id,
    p.valide,
    a.nom as atelier_nom,
    a.duree,
    a.nombre_places_max,
    a.enseignant_acronyme,
    a.enseignant2_acronyme,
    a.enseignant3_acronyme,
    s.nom as salle_nom,
    c.id as creneau_id,
    c.jour,
    c.periode,
    c.heure_debut,
    c.heure_fin,
    c.ordre,
    p.creneau_id as creneau_debut_id,
    (c.id = p.creneau_id) as est_creneau_debut,
    (SELECT COUNT(*) FROM inscriptions i WHERE i.atelier_id = p.atelier_id AND i.statut = 'confirmee') as nombre_inscrits
FROM planning p
JOIN ateliers a ON p.atelier_id = a.id
LEFT JOIN salles s ON p.salle_id = s.id
JOIN creneaux c_debut ON p.creneau_id = c_debut.id
JOIN creneaux c ON c.jour = c_debut.jour 
    AND c.ordre >= c_debut.ordre 
    AND c.ordre < c_debut.ordre + p.nombre_creneaux
ORDER BY c.ordre, s.nom;

-- ============================================
-- INSERTION DES DONNÉES INITIALES
-- ============================================

-- Créneaux horaires (14 créneaux)
INSERT INTO creneaux (jour, periode, heure_debut, heure_fin, ordre, actif) VALUES
('lundi', 'P1-2', '08:00:00', '09:35:00', 1, TRUE),
('lundi', 'P3-4', '09:50:00', '11:25:00', 2, TRUE),
('lundi', 'P6-7', '13:30:00', '15:05:00', 3, TRUE),
('mardi', 'P1-2', '08:00:00', '09:35:00', 4, TRUE),
('mardi', 'P3-4', '09:50:00', '11:25:00', 5, TRUE),
('mardi', 'P6-7', '13:30:00', '15:05:00', 6, TRUE),
('mercredi', 'P1-2', '08:00:00', '09:35:00', 7, TRUE),
('mercredi', 'P3-4', '09:50:00', '11:25:00', 8, TRUE),
('jeudi', 'P1-2', '08:00:00', '09:35:00', 9, TRUE),
('jeudi', 'P3-4', '09:50:00', '11:25:00', 10, TRUE),
('jeudi', 'P6-7', '13:30:00', '15:05:00', 11, TRUE),
('vendredi', 'P1-2', '08:00:00', '09:35:00', 12, TRUE),
('vendredi', 'P3-4', '09:50:00', '11:25:00', 13, TRUE),
('vendredi', 'P6-7', '13:30:00', '15:05:00', 14, TRUE);

-- Classes standard
INSERT INTO classes (nom, niveau, voie, annee) VALUES
('9VP1', '9', 'VP', 9), ('9VP2', '9', 'VP', 9), ('9VP3', '9', 'VP', 9),
('9VG1', '9', 'VG', 9), ('9VG2', '9', 'VG', 9), ('9VG3', '9', 'VG', 9),
('10VP1', '10', 'VP', 10), ('10VP2', '10', 'VP', 10), ('10VP3', '10', 'VP', 10),
('10VG1', '10', 'VG', 10), ('10VG2', '10', 'VG', 10), ('10VG3', '10', 'VG', 10),
('11VP1', '11', 'VP', 11), ('11VP2', '11', 'VP', 11), ('11VP3', '11', 'VP', 11),
('11VG1', '11', 'VG', 11), ('11VG2', '11', 'VG', 11), ('11VG3', '11', 'VG', 11);

-- Configuration par défaut
INSERT INTO configuration (cle, valeur, description) VALUES
('version', '5.3', 'Version de la plateforme'),
('inscriptions_ouvertes', 'false', 'Inscriptions élèves ouvertes'),
('quota_places_pourcent', '100', 'Pourcentage de places disponibles'),
('seuil_alerte_inscription', '30', 'Seuil alerte faible inscription'),
('nom_evenement', 'Semaine Spéciale', 'Nom de l''événement'),
('annee_scolaire', '2025-2026', 'Année scolaire');

-- Le compte admin sera créé automatiquement au premier démarrage
-- Identifiant: admin / Mot de passe: SemaineSpeciale2026!

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================
-- FIN DU SCHÉMA v5.3
-- ============================================
