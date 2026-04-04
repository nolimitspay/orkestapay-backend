/**
 * NoLimitsPay - Shopify Integration Script v1.0
 * Equivalent to cdn.hurrypayments.com/v1/hurry.min.js
 *
 * Client installs this ONE line in their Shopify theme (theme.liquid before </body>):
 * <script defer src="https://nolimitspay.com/nlp.js?shop=SHOP_ID"></script>
 *
 * That's it. The script does everything automatically.
 */

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const NLP_API = 'https://orkestapay-backend.onrender.com/api';
  const NLP_CHECKOUT = 'https://nolimitspay.com/checkout.html';

  // Get shop ID from script tag URL
  const scriptTag = document.currentScript || document.querySelector('script[src*="nlp.js"]');
  const scriptUrl = scriptTag ? scriptTag.src : '';
  const shopId = new URLSearchParams(scriptUrl.split('?')[1] || '').get('shop') || '';

  if (!shopId) {
    console.warn('[NoLimitsPay] No shop ID found. Add ?shop=YOUR_ID to the script URL.');
    return;
  }

  // ── LOAD SHOP CONFIG FROM BACKEND ──────────────────────────────────────────
  let shopConfig = null;

  async function loadConfig() {
    try {
      const res = await fetch(`${NLP_API}/shops/${shopId}/script-config`);
      if (!res.ok) throw new Error('Shop not found');
      shopConfig = await res.json();
    } catch (e) {
      console.warn('[NoLimitsPay] Could not load shop config:', e.message);
    }
  }

  // ── CREATE ORDER IN BACKEND ─────────────────────────────────────────────────
  async function createOrder(cartData) {
    try {
      const res = await fetch(`${NLP_API}/payments/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId,
          shopName: shopConfig?.name || Shopify?.shop || window.location.hostname,
          items: cartData.items || [],
          amount: cartData.total_price || 0,
          currency: cartData.currency || 'EUR',
          itemCount: cartData.item_count || 1,
        }),
      });
      if (!res.ok) throw new Error('Could not create order');
      return await res.json();
    } catch (e) {
      console.warn('[NoLimitsPay] Could not create order:', e.message);
      return null;
    }
  }

  // ── GET CART FROM SHOPIFY ───────────────────────────────────────────────────
  async function getCart() {
    try {
      const res = await fetch('/cart.js');
      return await res.json();
    } catch {
      return null;
    }
  }

  // ── REDIRECT TO NLP CHECKOUT ────────────────────────────────────────────────
  async function redirectToCheckout(e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    // Show loading state on button
    const btn = e.currentTarget;
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span style="opacity:0.7">Procesando...</span>';
    btn.disabled = true;

    try {
      // Get cart
      const cart = await getCart();
      if (!cart || !cart.total_price) {
        btn.innerHTML = originalText;
        btn.disabled = false;
        window.location.href = '/checkout';
        return;
      }

      // Create order in NoLimitsPay backend
      const order = await createOrder(cart);

      if (!order || !order.orderId) {
        // Fallback to Shopify checkout if something fails
        btn.innerHTML = originalText;
        btn.disabled = false;
        window.location.href = '/checkout';
        return;
      }

      // Build checkout URL
      const params = new URLSearchParams({
        orderId: order.orderId,
        shop: shopConfig?.name || window.location.hostname,
        successUrl: shopConfig?.successUrl || window.location.origin + '/pages/gracias',
        amount: cart.total_price,
        currency: cart.currency || 'EUR',
      });

      if (shopConfig?.logo) params.set('logo', shopConfig.logo);
      if (shopConfig?.timer) params.set('timer', shopConfig.timer);

      window.location.href = NLP_CHECKOUT + '?' + params.toString();

    } catch (err) {
      console.warn('[NoLimitsPay] Error:', err);
      btn.innerHTML = originalText;
      btn.disabled = false;
      window.location.href = '/checkout';
    }
  }

  // ── BIND CHECKOUT BUTTONS ───────────────────────────────────────────────────
  function bindButtons() {
    // All possible checkout button selectors in Shopify themes
    const selectors = [
      '[name="checkout"]',
      'button[data-checkout-button]',
      'input[name="checkout"]',
      '.cart__checkout',
      '.cart__checkout-button',
      '#CartDrawer-Checkout',
      '#cart-checkout-button',
      '.cart-checkout-button',
      '[id*="checkout"][type="submit"]',
      'button[data-action="checkout"]',
    ].join(', ');

    const buttons = document.querySelectorAll(selectors);

    buttons.forEach(btn => {
      // Skip if already bound
      if (btn.dataset.nlpBound) return;
      btn.dataset.nlpBound = '1';

      // Remove existing onclick to prevent Shopify redirect
      btn.removeAttribute('onclick');

      btn.addEventListener('click', redirectToCheckout, true);
    });
  }

  // ── OBSERVE FOR DYNAMIC BUTTONS (cart drawer etc) ───────────────────────────
  function observeButtons() {
    const observer = new MutationObserver(() => {
      bindButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── INIT ────────────────────────────────────────────────────────────────────
  async function init() {
    await loadConfig();
    bindButtons();
    observeButtons();
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
