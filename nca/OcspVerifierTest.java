// Cryptographically signed synthetic fixtures. RSA keys exist only in memory;
// these tests establish parser/policy behavior, not official NCA acceptance.
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Date;
import java.util.Hashtable;
import javax.security.auth.x500.X500Principal;
import com.sun.net.httpserver.HttpServer;

import kz.gov.pki.kalkan.asn1.DERNull;
import kz.gov.pki.kalkan.asn1.DERObjectIdentifier;
import kz.gov.pki.kalkan.asn1.DEROctetString;
import kz.gov.pki.kalkan.asn1.DERSequence;
import kz.gov.pki.kalkan.asn1.x509.BasicConstraints;
import kz.gov.pki.kalkan.asn1.x509.KeyUsage;
import kz.gov.pki.kalkan.asn1.x509.X509Extension;
import kz.gov.pki.kalkan.asn1.x509.X509Extensions;
import kz.gov.pki.kalkan.ocsp.BasicOCSPRespGenerator;
import kz.gov.pki.kalkan.ocsp.CertificateID;
import kz.gov.pki.kalkan.ocsp.CertificateStatus;
import kz.gov.pki.kalkan.ocsp.OCSPRespGenerator;
import kz.gov.pki.kalkan.ocsp.RespID;
import kz.gov.pki.kalkan.ocsp.RevokedStatus;
import kz.gov.pki.kalkan.ocsp.UnknownStatus;
import kz.gov.pki.kalkan.x509.X509V3CertificateGenerator;

public final class OcspVerifierTest {
  static final Date NOW = new Date(1_800_000_000_000L);
  static final byte[] NONCE = new byte[32];
  static int checks;
  static String label = "setup";
  static final KeyPairGenerator KEYS;
  static { try { KEYS = KeyPairGenerator.getInstance("RSA"); KEYS.initialize(2048); }
    catch (Exception error) { throw new ExceptionInInitializerError(error); } }

  static X509Certificate certificate(KeyPair key, X509Certificate issuer,
      KeyPair issuerKey, String mode) throws Exception {
    var generator = new X509V3CertificateGenerator();
    generator.setSerialNumber(BigInteger.valueOf(mode.hashCode()).abs().add(BigInteger.ONE));
    var subject = new X500Principal("CN=TEST OCSP " + mode);
    generator.setSubjectDN(subject);
    generator.setIssuerDN(issuer == null ? subject : issuer.getSubjectX500Principal());
    generator.setNotBefore(new Date(NOW.getTime() - 3_600_000));
    generator.setNotAfter(new Date(NOW.getTime() + (mode.equals("expired") ? -1000 : 3_600_000)));
    generator.setPublicKey(key.getPublic());
    generator.setSignatureAlgorithm("SHA256withRSA");
    boolean ca = issuer == null || mode.equals("test-issuer");
    generator.addExtension("2.5.29.19", true, new BasicConstraints(ca));
    generator.addExtension("2.5.29.15", true, new KeyUsage(ca
        ? KeyUsage.digitalSignature | KeyUsage.keyCertSign | KeyUsage.cRLSign
        : mode.equals("no-sign-usage") ? KeyUsage.keyEncipherment : KeyUsage.digitalSignature));
    if (issuer != null && !mode.equals("no-eku")) generator.addExtension("2.5.29.37", false,
        new DERSequence(new DERObjectIdentifier(OcspVerifier.SIGNING)));
    if (issuer != null && !mode.equals("no-check-missing")) generator.addExtension(
        OcspVerifier.NO_CHECK, false, mode.equals("no-check-invalid")
          ? new DEROctetString(new byte[]{1}) : DERNull.INSTANCE);
    if (mode.equals("critical")) generator.addExtension("1.2.3.4.5", true, DERNull.INSTANCE);
    return generator.generate(issuerKey.getPrivate(), CmsVerifier.PROVIDER.getName());
  }

  static X509Extensions critical() {
    var values = new Hashtable<DERObjectIdentifier, X509Extension>();
    values.put(new DERObjectIdentifier("1.2.3.4.5"), new X509Extension(true,
        new DEROctetString(new byte[]{5, 0})));
    return new X509Extensions(values);
  }

  static byte[] response(X509Certificate signer, KeyPair key, CertificateID id,
      String mode) throws Exception {
    var responder = mode.equals("wrong-responder-id")
        ? new RespID(new X500Principal("CN=TEST unrelated responder"))
        : mode.equals("by-name") ? new RespID(signer.getSubjectX500Principal()) : new RespID(signer.getPublicKey());
    var generator = new BasicOCSPRespGenerator(responder);
    long time = NOW.getTime();
    Date updated = new Date(time + (mode.equals("future-update") ? 120_000 :
        mode.equals("stale-update") ? -600_000 : -1000));
    Date produced = new Date(time + (mode.equals("future-produced") ? 120_000 :
        mode.equals("stale-produced") ? -600_000 : 0));
    Date next = mode.equals("no-next") ? null : new Date(time +
        (mode.equals("expired-next") ? -500 : mode.equals("before-this") ? -2000 : 10_000));
    CertificateStatus status = mode.equals("unknown") ? new UnknownStatus() :
        mode.equals("revoked") ? new RevokedStatus(new Date(time - 10_000), 1) : null;
    generator.addResponse(id, status, updated, next, mode.equals("critical-single") ? critical() : null);
    if (mode.equals("duplicate")) generator.addResponse(id, null, updated, next, null);
    if (!mode.equals("missing-nonce")) {
      byte[] nonce = NONCE.clone();
      if (mode.equals("wrong-nonce")) nonce[0]++;
      var extension = OcspVerifier.nonceExtension(nonce);
      generator.setResponseExtensions(mode.equals("critical-response") ? critical() : extension);
    }
    var basic = generator.generate(mode.equals("weak-signature") ? "SHA1withRSA" : "SHA256withRSA", key.getPrivate(),
        mode.equals("no-certificates") ? new X509Certificate[]{} : new X509Certificate[]{signer},
        produced, CmsVerifier.PROVIDER.getName());
    return new OCSPRespGenerator().generate(0, basic).getEncoded();
  }

  interface Check { void run() throws Exception; }
  static void accepts(String name, Check action) throws Exception {
    label = name; action.run(); checks++;
  }
  static void rejects(String name, Check action) throws Exception {
    label = name;
    boolean rejected = false;
    try { action.run(); } catch (Exception expected) { rejected = true; }
    if (!rejected) throw new IllegalStateException("negative fixture accepted");
    checks++;
  }

  public static void main(String[] args) {
    try { run(); System.out.println("{\"fixtureChecks\":" + checks + ",\"passed\":true}"); }
    catch (Exception error) { System.out.println("{\"fixtureFailure\":\"" + label +
        "\",\"stage\":\"" + OcspVerifier.stage + "\",\"type\":\"" +
        error.getClass().getSimpleName() + "\"}"); }
  }

  static void run() throws Exception {
    var issuerKey = KEYS.generateKeyPair();
    var issuer = certificate(issuerKey, null, issuerKey, "issuer");
    var delegateKey = KEYS.generateKeyPair();
    var delegate = certificate(delegateKey, issuer, issuerKey, "authorized");
    var strangerKey = KEYS.generateKeyPair();
    var stranger = certificate(strangerKey, null, strangerKey, "stranger");
    var id = new CertificateID(CertificateID.HASH_SHA1, issuer, BigInteger.valueOf(42),
        CmsVerifier.PROVIDER.getName());
    for (String mode : new String[]{"good", "no-certificates", "by-name", "no-next"}) accepts(mode, () -> {
      long until = OcspVerifier.validate(response(issuer, issuerKey, id, mode), id, NONCE, issuer, NOW);
      CmsVerifier.check(until > NOW.getTime() && until <= NOW.getTime() + OcspVerifier.MAX_AGE);
      if (!mode.equals("no-next")) CmsVerifier.check(until == NOW.getTime() + 10_000);
    });
    accepts("authorized-delegate", () -> OcspVerifier.validate(
        response(delegate, delegateKey, id, "good"), id, NONCE, issuer, NOW));
    for (String mode : new String[]{"missing-nonce", "wrong-nonce", "wrong-responder-id", "unknown", "revoked",
        "stale-update", "future-update", "stale-produced", "future-produced", "expired-next", "before-this",
        "duplicate", "critical-response", "critical-single", "weak-signature"}) rejects(mode, () -> OcspVerifier.validate(
            response(issuer, issuerKey, id, mode), id, NONCE, issuer, NOW));
    rejects("wrong-signature", () -> OcspVerifier.validate(
        response(issuer, strangerKey, id, "good"), id, NONCE, issuer, NOW));
    rejects("foreign-responder", () -> OcspVerifier.validate(
        response(stranger, strangerKey, id, "good"), id, NONCE, issuer, NOW));
    for (String mode : new String[]{"no-eku", "no-sign-usage", "no-check-missing", "no-check-invalid", "expired", "critical"}) {
      var certificate = certificate(delegateKey, issuer, issuerKey, mode);
      rejects(mode, () -> OcspVerifier.validate(response(certificate, delegateKey, id, "good"), id, NONCE, issuer, NOW));
    }
    var foreignDelegate = certificate(delegateKey, stranger, strangerKey, "foreign-issued");
    rejects("foreign-issuer", () -> OcspVerifier.validate(
        response(foreignDelegate, delegateKey, id, "good"), id, NONCE, issuer, NOW));
    for (var other : new CertificateID[]{
        new CertificateID(CertificateID.HASH_SHA1, issuer, BigInteger.valueOf(43), CmsVerifier.PROVIDER.getName()),
        new CertificateID(CertificateID.HASH_SHA1, stranger, BigInteger.valueOf(42), CmsVerifier.PROVIDER.getName()),
        new CertificateID(CertificateID.HASH_SHA256, issuer, BigInteger.valueOf(42), CmsVerifier.PROVIDER.getName())}) {
      rejects("different-cert-id", () -> OcspVerifier.validate(response(issuer, issuerKey, other, "good"), id, NONCE, issuer, NOW));
    }
    byte[] good = response(issuer, issuerKey, id, "good");
    rejects("trailing-asn1", () -> OcspVerifier.validate(Arrays.copyOf(good, good.length + 1), id, NONCE, issuer, NOW));
    rejects("too-large", () -> OcspVerifier.validate(new byte[OcspVerifier.MAX_RESPONSE + 1], id, NONCE, issuer, NOW));
    rejects("short-nonce", () -> OcspVerifier.validate(good, id, new byte[4], issuer, NOW));
    rejects("malformed", () -> OcspVerifier.validate(new byte[]{1,2,3}, id, NONCE, issuer, NOW));
    rejects("responder-error", () -> OcspVerifier.validate(new OCSPRespGenerator().generate(3, null).getEncoded(), id, NONCE, issuer, NOW));
    rejects("expired-at-use", () -> OcspVerifier.validate(good, id, NONCE, issuer, new Date(NOW.getTime() + 10_000)));
    var replaced = Files.createTempDirectory("dalahold-public-ca-fixture-");
    var rootPath = replaced.resolve("Keys and Certs/CA_Test/ROOT/root_test_gost_2022.cer");
    var issuerPath = replaced.resolve("Keys and Certs/CA_Test/NCA/nca_gost2022_test.cer");
    try {
      Files.createDirectories(rootPath.getParent());
      Files.createDirectories(issuerPath.getParent());
      Files.write(rootPath, issuer.getEncoded());
      Files.write(issuerPath, certificate(delegateKey, issuer, issuerKey, "test-issuer").getEncoded());
      rejects("unapproved-public-ca", () -> CmsVerifier.testChain(replaced, NOW));
    } finally {
      Files.deleteIfExists(rootPath); Files.deleteIfExists(issuerPath);
      Files.delete(rootPath.getParent()); Files.delete(issuerPath.getParent());
      Files.delete(rootPath.getParent().getParent());
      Files.delete(replaced.resolve("Keys and Certs")); Files.delete(replaced);
    }
    transport();
  }

  static void transport() throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    var executor = java.util.concurrent.Executors.newCachedThreadPool(r -> {
      var thread = new Thread(r); thread.setDaemon(true); return thread;
    });
    server.setExecutor(executor);
    server.createContext("/", request -> {
      try (request) {
        String mode = request.getRequestURI().getPath();
        byte[] body = request.getRequestBody().readAllBytes();
        if (!request.getRequestMethod().equals("POST") || !Arrays.equals(body, new byte[]{1,2,3}) ||
            !"application/ocsp-request".equals(request.getRequestHeaders().getFirst("Content-Type"))) {
          request.sendResponseHeaders(400, -1); return;
        }
        request.getResponseHeaders().set("Content-Type", mode.equals("/wrong-mime")
            ? "text/plain" : "application/ocsp-response");
        if (mode.equals("/redirect")) {
          request.getResponseHeaders().set("Location", "/good");
          request.sendResponseHeaders(302, -1); return;
        }
        if (mode.equals("/unavailable")) { request.sendResponseHeaders(503, -1); return; }
        if (mode.equals("/too-large")) {
          request.sendResponseHeaders(200, OcspVerifier.MAX_RESPONSE + 1L); return;
        }
        if (mode.equals("/empty")) { request.sendResponseHeaders(200, -1); return; }
        request.sendResponseHeaders(200, mode.equals("/stream-overflow") ? 0 : 1);
        if (mode.equals("/timeout")) {
          try { Thread.sleep(6000); } catch (InterruptedException stop) { return; }
        }
        request.getResponseBody().write(mode.equals("/stream-overflow")
            ? new byte[OcspVerifier.MAX_RESPONSE + 1] : new byte[]{42});
      } catch (java.io.IOException expectedDisconnect) { /* bounded client refused */ }
    });
    server.start();
    String base = "http://127.0.0.1:" + server.getAddress().getPort();
    try {
      accepts("bounded-post", () -> CmsVerifier.check(Arrays.equals(new byte[]{42},
          OcspVerifier.exchange(new URL(base + "/good"), new byte[]{1,2,3}))));
      for (String mode : new String[]{"redirect", "unavailable", "wrong-mime", "too-large", "empty", "stream-overflow", "timeout"}) {
        rejects("transport-" + mode, () -> OcspVerifier.exchange(new URL(base + "/" + mode), new byte[]{1,2,3}));
      }
    } finally { server.stop(0); executor.shutdownNow(); }
  }
}
