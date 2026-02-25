// Notification service interface and stub.
// Injected into handlers so tests can mock without module patching the whole file.

export interface NotificationService {
  // KYC transitions (MKPLS-370)
  sendKycVerified(sellerId: number): Promise<void>
  sendKycFailed(sellerId: number): Promise<void>

  // Fulfillment (MKPLS-363)
  // buyerOrderId is used to look up the buyer account in Hermes for delivery.
  sendTicketTransferred(buyerOrderId: string): Promise<void>
}

export class StubNotificationService implements NotificationService {
  async sendKycVerified(sellerId: number): Promise<void> {
    console.log(`[notifications] KYC verified — seller ${sellerId}`)
  }

  async sendKycFailed(sellerId: number): Promise<void> {
    console.log(`[notifications] KYC failed — seller ${sellerId}`)
  }

  async sendTicketTransferred(buyerOrderId: string): Promise<void> {
    // TODO MKPLS-382: integrate with Braze/FCM — ticket_transferred push + email
    console.log(`[notifications] Ticket transferred — buyer order ${buyerOrderId}`)
  }
}
