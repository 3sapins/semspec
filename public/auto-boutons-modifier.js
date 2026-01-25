/**
 * SCRIPT AUTO-AJOUT BOUTONS "MODIFIER"
 * À inclure dans index.html : <script src="auto-boutons-modifier.js"></script>
 * 
 * Ce script ajoute automatiquement des boutons "Modifier" sur chaque atelier
 * dans la liste des ateliers de l'interface admin.
 */

(function() {
    'use strict';
    
    // Fonction pour ajouter les boutons "Modifier"
    function ajouterBoutonsModifier() {
        // Trouver tous les conteneurs d'ateliers
        // Adapter les sélecteurs selon votre structure HTML
        const selectors = [
            '[data-atelier-id]',
            '.atelier-card[data-id]',
            '.atelier-item[data-atelier]'
        ];
        
        let atelierCards = [];
        for (const selector of selectors) {
            const found = document.querySelectorAll(selector);
            if (found.length > 0) {
                atelierCards = found;
                break;
            }
        }
        
        if (atelierCards.length === 0) {
            // Essayer de trouver par classe générique
            atelierCards = document.querySelectorAll('.atelier-card, .atelier-item, .workshop-card');
        }
        
        atelierCards.forEach(card => {
            // Récupérer l'ID de l'atelier
            const atelierId = card.dataset.atelierId || 
                             card.dataset.id || 
                             card.dataset.atelier ||
                             card.getAttribute('data-workshop-id');
            
            if (!atelierId) return;
            
            // Vérifier si bouton pas déjà présent
            if (card.querySelector('.btn-modifier-atelier')) return;
            
            // Trouver la zone d'actions (boutons)
            let actionsDiv = card.querySelector('.atelier-actions') ||
                           card.querySelector('.actions') ||
                           card.querySelector('.buttons') ||
                           card.querySelector('.card-actions');
            
            // Si pas de zone d'actions, en créer une
            if (!actionsDiv) {
                actionsDiv = document.createElement('div');
                actionsDiv.className = 'atelier-actions';
                card.appendChild(actionsDiv);
            }
            
            // Créer le bouton
            const btn = document.createElement('button');
            btn.className = 'btn btn-primary btn-modifier-atelier';
            btn.innerHTML = '✏️ Modifier';
            btn.style.cssText = `
                background: #667eea;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                font-size: 14px;
                margin: 5px;
                transition: all 0.3s;
            `;
            btn.onmouseover = () => {
                btn.style.background = '#5568d3';
                btn.style.transform = 'translateY(-2px)';
            };
            btn.onmouseout = () => {
                btn.style.background = '#667eea';
                btn.style.transform = 'translateY(0)';
            };
            btn.onclick = () => {
                window.location.href = `modifier-atelier.html?id=${atelierId}`;
            };
            
            // Ajouter le bouton
            actionsDiv.appendChild(btn);
        });
    }
    
    // Exécuter au chargement de la page
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(ajouterBoutonsModifier, 500);
        });
    } else {
        setTimeout(ajouterBoutonsModifier, 500);
    }
    
    // Observer les changements du DOM pour ajouter les boutons quand la liste est mise à jour
    const observer = new MutationObserver(() => {
        ajouterBoutonsModifier();
    });
    
    // Observer le conteneur principal
    const containers = ['#ateliersContainer', '#workshopsContainer', '.ateliers-list', 'main'];
    containers.forEach(selector => {
        const container = document.querySelector(selector);
        if (container) {
            observer.observe(container, {
                childList: true,
                subtree: true
            });
        }
    });
    
    // Réexécuter toutes les 2 secondes en cas de chargement asynchrone
    setInterval(ajouterBoutonsModifier, 2000);
    
    console.log('✅ Script auto-boutons-modifier chargé');
})();
