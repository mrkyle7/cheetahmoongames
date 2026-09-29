# ---------------------------------------------------------------------------
# Sending email as @cheetahmoongames.com through Brevo (password reset emails;
# see "Password reset emails" in the README).
#
# These records let Brevo, and the mail providers receiving its emails, check
# that it may send for this domain. They come from Brevo → Senders, Domains &
# Dedicated IPs → Domains → cheetahmoongames.com. DNS is public, so none of
# this is secret; the API key is (it's in Secret Manager, not here).
# ---------------------------------------------------------------------------

# Proves to Brevo that we own the domain.
resource "google_dns_record_set" "brevo_code" {
  project      = var.project_name
  managed_zone = var.dns_zone
  name         = "${var.domain_name}."
  type         = "TXT"
  ttl          = 300
  rrdatas      = ["\"brevo-code:7c8b2d531c1948f3121e3b838ba66882\""]
}

# DKIM: the keys Brevo signs our emails with.
resource "google_dns_record_set" "brevo_dkim" {
  for_each     = toset(["1", "2"])
  project      = var.project_name
  managed_zone = var.dns_zone
  name         = "brevo${each.value}._domainkey.${var.domain_name}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["b${each.value}.cheetahmoongames-com.dkim.brevo.com."]
}

# DMARC: tells receivers to accept signed mail and send reports to Brevo.
# p=none only reports; it doesn't ask receivers to reject anything.
resource "google_dns_record_set" "dmarc" {
  project      = var.project_name
  managed_zone = var.dns_zone
  name         = "_dmarc.${var.domain_name}."
  type         = "TXT"
  ttl          = 300
  rrdatas      = ["\"v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com\""]
}
