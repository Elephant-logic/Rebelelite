/**
 * STRIPE PAYMENT HANDLER
 * Handles Stripe Checkout Sessions and Webhooks for Foundation Room purchases
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class StripeHandler {
  constructor(foundationRegistry) {
    this.registry = foundationRegistry;
    this.endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  }

  /**
   * Create a Stripe Checkout Session for room purchase
   */
  async createCheckoutSession(roomName, password, email, successUrl, cancelUrl) {
    // Validate room is available
    if (!this.registry.isAvailable(roomName)) {
      throw new Error('Room name is not available');
    }

    // Validate room name format
    if (!/^[a-z0-9-]{3,32}$/.test(roomName)) {
      throw new Error('Room name must be 3-32 characters (lowercase letters, numbers, hyphens only)');
    }

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'Foundation Room - Lifetime Ownership',
                description: `Permanent ownership of room name: "${roomName}"`,
                images: ['https://your-domain.com/assets/foundation-room-badge.png']
              },
              unit_amount: this.registry.registry.price
            },
            quantity: 1
          }
        ],
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: email,
        metadata: {
          type: 'foundation_room',
          roomName: roomName,
          password: password, // Encrypted in production!
          purchaserEmail: email
        },
        payment_intent_data: {
          metadata: {
            type: 'foundation_room',
            roomName: roomName
          }
        }
      });

      return {
        sessionId: session.id,
        url: session.url
      };
    } catch (err) {
      console.error('[Stripe] Checkout session error:', err);
      throw err;
    }
  }

  /**
   * Handle Stripe webhook events
   */
  async handleWebhook(rawBody, signature) {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.endpointSecret
      );
    } catch (err) {
      console.error('[Stripe] Webhook signature verification failed:', err.message);
      throw new Error('Invalid signature');
    }

    console.log('[Stripe] Webhook event:', event.type);

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object);
        break;

      case 'payment_intent.succeeded':
        console.log('[Stripe] Payment succeeded:', event.data.object.id);
        break;

      case 'payment_intent.payment_failed':
        console.log('[Stripe] Payment failed:', event.data.object.id);
        break;

      default:
        console.log('[Stripe] Unhandled event type:', event.type);
    }

    return { received: true };
  }

  /**
   * Handle successful checkout completion
   */
  async handleCheckoutCompleted(session) {
    console.log('[Stripe] Checkout completed:', session.id);

    // Extract metadata
    const metadata = session.metadata;
    
    if (metadata.type !== 'foundation_room') {
      console.log('[Stripe] Not a foundation room purchase');
      return;
    }

    const { roomName, password, purchaserEmail } = metadata;

    try {
      // Register the room in the foundation registry
      const result = await this.registry.purchase(
        roomName,
        password,
        purchaserEmail || session.customer_email,
        session.id
      );

      console.log('[Stripe] Foundation room registered:', result);

      // TODO: Send confirmation email to customer
      // TODO: Broadcast to all connected clients that a room was sold

      return result;
    } catch (err) {
      console.error('[Stripe] Error registering foundation room:', err);
      // TODO: Handle the case where payment succeeded but registration failed
      // This might require manual intervention or automatic refund
      throw err;
    }
  }

  /**
   * Create a portal session for customer management
   */
  async createPortalSession(customerId, returnUrl) {
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl
      });

      return session.url;
    } catch (err) {
      console.error('[Stripe] Portal session error:', err);
      throw err;
    }
  }

  /**
   * Get payment information for a session
   */
  async getSessionInfo(sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return {
        id: session.id,
        status: session.payment_status,
        amount: session.amount_total,
        customerEmail: session.customer_email,
        metadata: session.metadata
      };
    } catch (err) {
      console.error('[Stripe] Session retrieval error:', err);
      throw err;
    }
  }
}

module.exports = StripeHandler;
