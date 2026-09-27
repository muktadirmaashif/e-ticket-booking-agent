/**
 * E-Ticket Auto Booker - Human-in-the-Loop System
 * Provides confirmation overlays, toast notifications, and progress tracking.
 * Depends on: utils.js (ETB namespace), overlay.css
 */

(function () {
  'use strict';

  // ─── Toast Container ────────────────────────────────────────────────────
  let toastContainer = null;

  function getToastContainer() {
    if (!toastContainer || !document.body.contains(toastContainer)) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'etb-toast-container';
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  const TOAST_ICONS = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  };

  /**
   * Show a brief toast notification.
   * @param {string} message
   * @param {'info'|'success'|'warning'|'error'} type
   * @param {number} duration - auto-dismiss in ms (default 4000)
   */
  ETB.showNotification = function showNotification(message, type = 'info', duration = 4000) {
    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `etb-toast etb-toast-${type}`;
    toast.innerHTML = `
      <span class="etb-toast-icon">${TOAST_ICONS[type] || 'ℹ️'}</span>
      <span>${message}</span>
    `;
    container.appendChild(toast);

    // Auto-dismiss
    setTimeout(() => {
      toast.classList.add('etb-toast-exit');
      setTimeout(() => toast.remove(), 300);
    }, duration);

    return toast;
  };

  // ─── Progress Bar ──────────────────────────────────────────────────────
  let progressBar = null;

  /**
   * Show or update a progress bar at the top of the page.
   * @param {number} step - Current step (1-indexed)
   * @param {number} totalSteps
   * @param {string} description
   */
  ETB.showProgress = function showProgress(step, totalSteps, description) {
    if (!progressBar || !document.body.contains(progressBar)) {
      progressBar = document.createElement('div');
      progressBar.className = 'etb-progress-bar';
      progressBar.innerHTML = `
        <span class="etb-progress-bar-logo">🚂 ETB</span>
        <div class="etb-progress-track">
          <div class="etb-progress-fill" style="width: 0%"></div>
        </div>
        <span class="etb-progress-step"></span>
        <span class="etb-progress-text"></span>
      `;
      document.body.appendChild(progressBar);
    }

    const pct = Math.round((step / totalSteps) * 100);
    progressBar.querySelector('.etb-progress-fill').style.width = `${pct}%`;
    progressBar.querySelector('.etb-progress-step').textContent = `${step}/${totalSteps}`;
    progressBar.querySelector('.etb-progress-text').textContent = description;

    // Also update booking status in background
    ETB.updateBookingStatus(step, description);
  };

  /**
   * Hide the progress bar.
   */
  ETB.hideProgress = function hideProgress() {
    if (progressBar) {
      progressBar.remove();
      progressBar = null;
    }
  };

  // ─── Confirmation Overlay ──────────────────────────────────────────────

  /**
   * Show a full-page confirmation overlay before payment.
   * @param {Object} options
   * @param {string} options.title - e.g. "Ready to Pay"
   * @param {string} options.subtitle - e.g. "Please review your booking details"
   * @param {Array<{label: string, value: string}>} options.details - Summary rows
   * @param {string} options.totalLabel - e.g. "Total Amount"
   * @param {string} options.totalValue - e.g. "৳ 1,200"
   * @param {string} options.confirmText - Button text (default "CONFIRM & PROCEED")
   * @param {string} options.cancelText - Button text (default "CANCEL")
   * @returns {Promise<boolean>} - true if confirmed, false if cancelled
   */
  ETB.showConfirmation = function showConfirmation(options) {
    return new Promise((resolve) => {
      const {
        title = 'Confirm Action',
        subtitle = 'Please review the details below',
        details = [],
        totalLabel = 'Total',
        totalValue = '',
        confirmText = '✅ CONFIRM & PROCEED',
        cancelText = '❌ CANCEL'
      } = options;

      // Build detail rows HTML
      const detailRows = details.map(d => `
        <div class="etb-confirm-summary-row">
          <span class="etb-label">${d.label}</span>
          <span class="etb-value">${d.value}</span>
        </div>
      `).join('');

      const totalRow = totalValue ? `
        <div class="etb-confirm-total">
          <span>${totalLabel}</span>
          <span>${totalValue}</span>
        </div>
      ` : '';

      // Create overlay
      const overlay = document.createElement('div');
      overlay.className = 'etb-overlay';
      overlay.innerHTML = `
        <div class="etb-confirm-card">
          <div class="etb-confirm-header">
            <h2>${title}</h2>
            <p>${subtitle}</p>
          </div>
          <div class="etb-confirm-body">
            <div class="etb-confirm-summary">
              ${detailRows}
              ${totalRow}
            </div>
          </div>
          <div class="etb-confirm-footer">
            <button class="etb-btn etb-btn-cancel" id="etb-cancel-btn">${cancelText}</button>
            <button class="etb-btn etb-btn-confirm" id="etb-confirm-btn">${confirmText}</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // Handlers
      const cleanup = (result) => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.2s ease';
        setTimeout(() => overlay.remove(), 200);
        resolve(result);
      };

      overlay.querySelector('#etb-confirm-btn').addEventListener('click', () => cleanup(true));
      overlay.querySelector('#etb-cancel-btn').addEventListener('click', () => cleanup(false));

      // Allow ESC to cancel
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', escHandler);
          cleanup(false);
        }
      };
      document.addEventListener('keydown', escHandler);
    });
  };

  // ─── Status Badge ──────────────────────────────────────────────────────
  let statusBadge = null;

  /**
   * Show a floating status badge in the bottom-right corner.
   * @param {string} text
   * @param {boolean} active
   */
  ETB.showStatusBadge = function showStatusBadge(text, active = true) {
    if (!statusBadge || !document.body.contains(statusBadge)) {
      statusBadge = document.createElement('div');
      statusBadge.className = 'etb-status-badge';
      statusBadge.innerHTML = `
        <span class="etb-status-badge-dot"></span>
        <span class="etb-status-badge-text"></span>
      `;
      document.body.appendChild(statusBadge);

      // Click to toggle visibility of details
      statusBadge.addEventListener('click', () => {
        ETB.showNotification('E-Ticket Auto Booker is running', 'info');
      });
    }

    statusBadge.querySelector('.etb-status-badge-text').textContent = text;
    statusBadge.classList.toggle('etb-inactive', !active);
  };

  /**
   * Hide the status badge.
   */
  ETB.hideStatusBadge = function hideStatusBadge() {
    if (statusBadge) {
      statusBadge.remove();
      statusBadge = null;
    }
  };

  ETB.log('Human-in-the-loop module loaded');
})();
