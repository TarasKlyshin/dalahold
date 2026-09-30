// TEST issuer only. No private key, certificate-controlled URL or status fallback.
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Date;
import java.util.Hashtable;
import java.util.List;
import java.util.Set;

import kz.gov.pki.kalkan.asn1.ASN1InputStream;
import kz.gov.pki.kalkan.asn1.ASN1OctetString;
import kz.gov.pki.kalkan.asn1.DERNull;
import kz.gov.pki.kalkan.asn1.DERObject;
import kz.gov.pki.kalkan.asn1.DERObjectIdentifier;
import kz.gov.pki.kalkan.asn1.DEROctetString;
import kz.gov.pki.kalkan.asn1.x509.X509Extension;
import kz.gov.pki.kalkan.asn1.x509.X509Extensions;
import kz.gov.pki.kalkan.ocsp.BasicOCSPResp;
import kz.gov.pki.kalkan.ocsp.CertificateID;
import kz.gov.pki.kalkan.ocsp.OCSPReqGenerator;
import kz.gov.pki.kalkan.ocsp.OCSPResp;
import kz.gov.pki.kalkan.ocsp.RespID;

public final class OcspVerifier {
  static final String NONCE = "1.3.6.1.5.5.7.48.1.2";
  static final String NO_CHECK = "1.3.6.1.5.5.7.48.1.5";
  static final String SIGNING = "1.3.6.1.5.5.7.3.9";
  static final long MAX_AGE = 300_000, SKEW = 60_000;
  static final int MAX_RESPONSE = 65_536;
  static String stage = "ocsp_transport";

  static void check(boolean condition) { CmsVerifier.check(condition); }

  static DERObject decoded(byte[] encoded) throws Exception {
    check(encoded != null);
    try (var input = new ASN1InputStream(encoded)) {
      var value = input.readObject();
      check(value != null && input.readObject() == null);
      return value;
    }
  }

  static DERObject extension(byte[] encoded) throws Exception {
    return decoded(((ASN1OctetString) decoded(encoded)).getOctets());
  }

  static X509Extensions nonceExtension(byte[] nonce) throws Exception {
    check(nonce != null && nonce.length == 32);
    var values = new Hashtable<DERObjectIdentifier, X509Extension>();
    values.put(new DERObjectIdentifier(NONCE), new X509Extension(false,
        new DEROctetString(new DEROctetString(nonce))));
    return new X509Extensions(values);
  }

  static boolean noCritical(java.security.cert.X509Extension value) {
    var critical = value.getCriticalExtensionOIDs();
    return critical == null || critical.isEmpty();
  }

  static long responder(BasicOCSPResp response, X509Certificate issuer, Date now)
      throws Exception {
    stage = "ocsp_responder";
    var candidates = new java.util.ArrayList<X509Certificate>();
    candidates.add(issuer);
    candidates.addAll(List.of(response.getCerts(CmsVerifier.PROVIDER.getName())));
    check(candidates.size() <= 6);
    for (var candidate : candidates) {
      if (!response.getResponderId().equals(new RespID(candidate.getSubjectX500Principal())) &&
          !response.getResponderId().equals(new RespID(candidate.getPublicKey()))) continue;
      candidate.checkValidity(now);
      candidate.checkValidity(response.getProducedAt());
      if (!candidate.equals(issuer)) {
        stage = "ocsp_responder_purpose";
        check(candidate.getBasicConstraints() < 0);
        check(candidate.getIssuerX500Principal().equals(issuer.getSubjectX500Principal()));
        var usage = candidate.getKeyUsage();
        check(usage != null && usage.length > 0 && usage[0]);
        var eku = candidate.getExtendedKeyUsage();
        check(eku != null && eku.contains(SIGNING));
        var critical = candidate.getCriticalExtensionOIDs();
        check(critical == null || Set.of("2.5.29.19", "2.5.29.15", "2.5.29.37").containsAll(critical));
        stage = "ocsp_responder_issuer";
        CmsVerifier.checkSignature(candidate.getSigAlgName(), issuer.getPublicKey(),
            candidate.getTBSCertificate(), candidate.getSignature());
        // No recursion or reliance on the incompatible CRLs. A delegated
        // responder lacking noCheck requires a separate revocation path.
        stage = "ocsp_responder_no_check";
        check(extension(candidate.getExtensionValue(NO_CHECK)) instanceof DERNull);
      }
      stage = "ocsp_signature";
      check(response.getSignatureAlgOID().equals(issuer.getSigAlgOID()) ||
          Set.of("1.2.840.113549.1.1.11", "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13")
            .contains(response.getSignatureAlgOID()));
      CmsVerifier.checkSignature(response.getSignatureAlgName(), candidate.getPublicKey(),
          response.getTBSResponseData(), response.getSignature());
      return Math.min(issuer.getNotAfter().getTime(), candidate.getNotAfter().getTime());
    }
    throw new IllegalArgumentException("test verification rejected");
  }

  static long validate(byte[] encoded, CertificateID requested, byte[] nonce,
      X509Certificate issuer, Date now) throws Exception {
    stage = "ocsp_structure";
    issuer.checkValidity(now);
    check(requested.matchesIssuer(issuer, CmsVerifier.PROVIDER.getName()));
    check(encoded.length > 0 && encoded.length <= MAX_RESPONSE && nonce.length == 32);
    var outer = new OCSPResp(encoded);
    check(Arrays.equals(encoded, outer.getEncoded()));
    check(outer.getStatus() == 0);
    check(outer.getResponseObject() instanceof BasicOCSPResp);
    var response = (BasicOCSPResp) outer.getResponseObject();
    check(response.getVersion() == 1 && noCritical(response));
    var answers = response.getResponses();
    check(answers.length == 1 && noCritical(answers[0]));
    stage = "ocsp_binding";
    check(requested.equals(answers[0].getCertID()));
    check(Arrays.equals(nonce, ((ASN1OctetString)
        extension(response.getExtensionValue(NONCE))).getOctets()));
    long until = responder(response, issuer, now);
    stage = "ocsp_freshness";
    long current = now.getTime(), produced = response.getProducedAt().getTime();
    long updated = answers[0].getThisUpdate().getTime();
    check(updated <= current + SKEW && updated >= current - MAX_AGE);
    check(produced <= current + SKEW && produced >= current - MAX_AGE && produced >= updated - SKEW);
    until = Math.min(until, Math.min(updated + MAX_AGE, produced + MAX_AGE));
    if (answers[0].getNextUpdate() != null) {
      long next = answers[0].getNextUpdate().getTime();
      check(next > current && next > updated);
      until = Math.min(until, next);
    }
    check(until > current);
    stage = "ocsp_status";
    check(answers[0].getCertStatus() == null); // only GOOD; revoked/unknown refuse
    return Math.min(until, current + MAX_AGE);
  }

  static long online(X509Certificate leaf, X509Certificate issuer) throws Exception {
    byte[] nonce = new byte[32];
    new SecureRandom().nextBytes(nonce);
    var id = new CertificateID(CertificateID.HASH_SHA1, issuer, leaf.getSerialNumber(),
        CmsVerifier.PROVIDER.getName()); // identifier digest, not signature algorithm
    var generator = new OCSPReqGenerator();
    generator.addRequest(id);
    generator.setRequestExtensions(nonceExtension(nonce));
    byte[] request = generator.generate().getEncoded();
    byte[] encoded = exchange(new URL("http://test.pki.gov.kz/ocsp/"), request);
    return validate(encoded, id, nonce, issuer, new Date());
  }

  // Internal transport seam for loopback fault fixtures. The server has no URL
  // setting; online() always uses the fixed public TEST endpoint above.
  static byte[] exchange(URL endpoint, byte[] request) throws Exception {
    stage = "ocsp_transport";
    var connection = (HttpURLConnection) endpoint.openConnection();
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(5000);
    connection.setReadTimeout(5000);
    connection.setRequestMethod("POST");
    connection.setDoOutput(true);
    connection.setFixedLengthStreamingMode(request.length);
    connection.setRequestProperty("Content-Type", "application/ocsp-request");
    connection.setRequestProperty("Accept", "application/ocsp-response");
    try {
      try (var output = connection.getOutputStream()) { output.write(request); }
      check(connection.getResponseCode() == 200);
      check("application/ocsp-response".equalsIgnoreCase(connection.getContentType()));
      check(connection.getContentLengthLong() <= MAX_RESPONSE);
      byte[] encoded;
      try (var input = connection.getInputStream()) { encoded = input.readNBytes(MAX_RESPONSE + 1); }
      check(encoded.length > 0 && encoded.length <= MAX_RESPONSE);
      return encoded;
    } finally { connection.disconnect(); }
  }
}
