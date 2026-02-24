// MKPLS-370: Notification service interface
//
// Implementations send email + push to sellers on KYC status transitions.
// The stub is used until a real provider (Braze, SendGrid, FCM) is wired up.
// Injected into makeAdyenWebhookHandler so tests can mock it without module patching.

export interface NotificationService {
  // Fired after KYC is approved. Sends email + push with "you can now list tickets" message.
  sendKycVerified(sellerId: number): Promise<void>

  // Fired after KYC is rejected. Sends email with actionable remediation steps.
  sendKycFailed(sellerId: number): Promise<void>
}

export class StubNotificationService implements NotificationService {
  async sendKycVerified(sellerId: number): Promise<void> {
    // TODO MKPLS-TBD: integrate with Braze / FCM for email + push
    console.log(`[notifications] KYC verified — seller ${sellerId}`)
  }

  async sendKycFailed(sellerId: number): Promise<void> {
    // TODO MKPLS-TBD: integrate with Braze / SendGrid for remediation email
    console.log(`[notifications] KYC failed — seller ${sellerId}`)
  }
}
