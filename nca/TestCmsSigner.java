// Test harness only. Bundled test P12 selection is fixed; CMS stdout is captured
// in memory by sdk.test.mjs. The production verifier never invokes this class.
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URL;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.List;

import kz.gov.pki.kalkan.jce.provider.cms.CMSSignedData;
import kz.gov.pki.kalkan.jce.provider.cms.SignerInformationStore;
import kz.gov.pki.provider.utils.CMSUtil;
import kz.gov.pki.provider.utils.OCSPUtil;
import kz.gov.pki.provider.utils.model.SigningEntity;
import kz.gov.pki.reference.KalkanHashAlgorithm;
import kz.gov.pki.reference.KNCAServiceRequestMethod;

public final class TestCmsSigner {
  static String phase = "input";
  static SigningEntity entity(Path sdk, char[] password, String mode) throws Exception {
    Path testRoot = sdk.resolve("Keys and Certs/Gost2015").toRealPath();
    CmsVerifier.check(testRoot.startsWith(sdk.toRealPath()));
    boolean wrongPurpose = mode.equals("wrong-purpose") || mode.equals("wrong-purpose-checks");
    String period = mode.equals("expired") ? "2024.10.29-2025.10.29" : "2026.05.08-2027.05.07";
    Path directory = sdk.resolve("Keys and Certs/Gost2015/" + period);
    if (List.of("legal-signer", "legal-employee", "legal-director").contains(mode)) {
      String role = mode.equals("legal-signer") ? "Сотрудник с правом подписи" :
          mode.equals("legal-employee") ? "Сотрудник организации" : "Первый руководитель";
      try (var directories = Files.list(directory.resolve("Юридическое лицо"))) {
        var matches = directories.filter(path -> java.text.Normalizer.normalize(
            path.getFileName().toString(), java.text.Normalizer.Form.NFC).equals(role))
            .toList();
        CmsVerifier.check(matches.size() == 1);
        directory = matches.get(0).resolve("valid");
      }
    } else if (!wrongPurpose) directory = directory.resolve("Физическое лицо").resolve(
        mode.equals("expired") ? "Valid" : mode.equals("revoked") ? "revoked" : "valid");
    CmsVerifier.check(directory.toRealPath().startsWith(testRoot));
    try (var files = Files.walk(directory)) {
      for (Path file : files.filter(path -> path.toString().endsWith(".p12")).sorted().toList()) {
        if (wrongPurpose && !file.getParent().getFileName().toString().equalsIgnoreCase("valid")) continue;
        CmsVerifier.check(file.toRealPath().startsWith(directory.toRealPath()));
        var store = KeyStore.getInstance("PKCS12", CmsVerifier.PROVIDER);
        try (var input = Files.newInputStream(file)) { store.load(input, password); }
        for (var names = store.aliases(); names.hasMoreElements();) {
          String alias = names.nextElement();
          if (!store.isKeyEntry(alias)) continue;
          var certificate = (X509Certificate) store.getCertificate(alias);
          var eku = certificate.getExtendedKeyUsage();
          boolean signing = eku != null && eku.contains(CmsVerifier.SIGNING_EKU);
          if (wrongPurpose == signing) continue;
          var chain = new ArrayList<X509Certificate>();
          for (var cert : store.getCertificateChain(alias)) chain.add((X509Certificate) cert);
          return new SigningEntity((PrivateKey) store.getKey(alias, password), chain);
        }
      }
    }
    throw new IllegalStateException("test key unavailable");
  }

  interface Check { void run() throws Exception; }
  static void rejects(Check check) throws Exception {
    boolean rejected = false;
    try { check.run(); } catch (Exception expected) { rejected = true; }
    if (!rejected) throw new IllegalStateException("negative test accepted");
  }

  public static void main(String[] args) {
    try { run(args); }
    catch (Exception error) {
      System.out.println("{\"testError\":\"" + phase + "\",\"type\":\"" +
          error.getClass().getSimpleName() + "\",\"reason\":\"" +
          (phase.equals("strict_test_ocsp") ? OcspVerifier.stage : "test_fixture") + "\"}");
    }
  }

  static void run(String[] args) throws Exception {
    CmsVerifier.check(args.length == 3);
    CmsVerifier.check(List.of("sign", "pem", "attached", "multi", "expired", "revoked",
        "wrong-purpose", "wrong-purpose-checks", "crypto-checks", "checks",
        "ocsp-diagnostic", "ocsp-check", "legal-signer", "legal-employee",
        "legal-director").contains(args[1]));
    Path sdk = Path.of(args[0]);
    var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    char[] password = input.readLine().toCharArray();
    phase = "load_test_key";
    SigningEntity signing;
    try { signing = entity(sdk, password, args[1]); }
    finally { Arrays.fill(password, '\0'); }
    if (args[1].equals("ocsp-diagnostic")) {
      // Reachability diagnostic only. SDK utility omits responder authorization,
      // response-to-request CertID and freshness checks: never an acceptance gate.
      phase = "test_ocsp_request";
      var factory = CertificateFactory.getInstance("X.509", CmsVerifier.PROVIDER);
      X509Certificate ca;
      try (var certificate = Files.newInputStream(sdk.resolve(
          "Keys and Certs/CA_Test/NCA/nca_gost2022_test.cer"))) {
        ca = (X509Certificate) factory.generateCertificate(certificate);
      }
      var status = OCSPUtil.verify(signing.getCertificateChain().get(0), ca,
          new URL("http://test.pki.gov.kz/ocsp/"), KalkanHashAlgorithm.HASH_SHA1,
          KNCAServiceRequestMethod.POST, true, CmsVerifier.PROVIDER);
      System.out.println("{\"testOcspResponded\":true,\"utilityStatus\":\"" +
          (status == null ? "good" : status.getClass().getSimpleName()) +
          "\",\"authorizationUsable\":false}");
      return;
    }
    byte[] bytes = Base64.getDecoder().decode(input.readLine());
    phase = "create_cms";
    var signed = CMSUtil.createCAdES(signing, bytes, args[1].equals("attached"), CmsVerifier.PROVIDER);
    if (args[1].equals("multi")) {
      var one = signed.getSignerInfos().getSigners().iterator().next();
      signed = CMSSignedData.replaceSigners(signed, new SignerInformationStore(List.of(one, one)));
    }
    byte[] cms = signed.getEncoded();
    if (args[1].startsWith("wrong-purpose")) {
      // Non-vacuous fixture: valid CA-issued certificate and exact CMS, but
      // missing this stand's required signing EKU. Never synthesize a cert.
      phase = "wrong_purpose_fixture";
      var certificate = signing.getCertificateChain().get(0);
      var assets = CmsVerifier.testChain(sdk, new Date());
      certificate.checkValidity();
      CmsVerifier.check(certificate.getIssuerX500Principal().equals(assets.ca().getSubjectX500Principal()));
      CmsVerifier.check(certificate.getBasicConstraints() < 0);
      var usage = certificate.getKeyUsage();
      CmsVerifier.check(usage != null && usage.length > 1 && (usage[0] || usage[1]));
      CmsVerifier.check(certificate.getExtendedKeyUsage() != null &&
          !certificate.getExtendedKeyUsage().contains(CmsVerifier.SIGNING_EKU));
      CmsVerifier.checkSignature(certificate.getSigAlgName(), assets.ca().getPublicKey(),
          certificate.getTBSCertificate(), certificate.getSignature());
      CMSUtil.verifyCMS(cms, bytes, CmsVerifier.PROVIDER);
      if (args[1].equals("wrong-purpose-checks")) {
        System.out.println("{\"wrongPurposeFixture\":true,\"issuerSignature\":true,\"currentlyValid\":true,\"exactCms\":true,\"missingSigningEku\":true}");
        return;
      }
    }
    if (args[1].equals("revoked")) {
      phase = "revoked_fixture_crypto";
      CmsVerifier.verifiedSigner(cms, bytes, CmsVerifier.testChain(sdk, new Date()), new Date());
    }
    if (args[1].equals("pem")) {
      // Same Kalkan PEMWriter used by installed NCALayer Basics; test output
      // is captured in memory, never written to logs or fixture files.
      var text = new java.io.StringWriter();
      try (var writer = new kz.gov.pki.kalkan.openssl.PEMWriter(text)) {
        writer.writeObject(signed);
      }
      System.out.print(text.toString());
      return;
    }
    if (args[1].equals("ocsp-check")) {
      phase = "verify_exact_cms";
      var assets = CmsVerifier.testChain(sdk, new Date());
      var signer = CmsVerifier.verifiedSigner(cms, bytes, assets, new Date());
      phase = "strict_test_ocsp";
      long until = OcspVerifier.online(signer, assets.ca());
      System.out.println("{\"strictTestOcsp\":true,\"validUntil\":" + until + "}");
      return;
    }
    if (args[1].equals("crypto-checks")) {
      CMSUtil.verifyCMS(cms, bytes, CmsVerifier.PROVIDER);
      rejects(() -> CMSUtil.verifyCMS(cms, "altered".getBytes(StandardCharsets.UTF_8), CmsVerifier.PROVIDER));
      CmsVerifier.check(CMSUtil.parseAsCMS(cms).getSignedContent() == null);
      CmsVerifier.check(CMSUtil.getSignerInformations(CMSUtil.parseAsCMS(cms)).size() == 1);
      System.out.println("{\"cryptoChecks\":4,\"passed\":true,\"signatureOnly\":true}");
      return;
    }
    if (!args[1].equals("checks")) {
      System.out.println(Base64.getEncoder().encodeToString(cms));
      return;
    }
    phase = "assets";
    var crlDirectory = Path.of(args[2]);
    var assets = CmsVerifier.assets(sdk, crlDirectory, new Date());
    phase = "exact_bytes";
    CmsVerifier.verify(cms, bytes, assets, new Date());
    phase = "altered_bytes";
    rejects(() -> CmsVerifier.verify(cms, "altered".getBytes(StandardCharsets.UTF_8), assets, new Date()));
    phase = "stale_status";
    rejects(() -> CmsVerifier.assets(sdk, crlDirectory, new Date(assets.validUntil() + 1)));
    phase = "missing_assets";
    rejects(() -> CmsVerifier.assets(sdk, crlDirectory.resolve("missing-test-assets"), new Date()));
    phase = "missing_crl";
    var withoutCrl = new CmsVerifier.Assets(assets.root(), assets.ca(), List.of(), assets.validUntil());
    rejects(() -> CmsVerifier.verify(cms, bytes, withoutCrl, new Date()));
    phase = "expired_signer";
    var distantStatus = new CmsVerifier.Assets(assets.root(), assets.ca(), assets.crls(), Long.MAX_VALUE);
    rejects(() -> CmsVerifier.verify(cms, bytes, distantStatus, new Date(4_102_444_800_000L)));
    System.out.println("{\"sdkChecks\":6,\"passed\":true}");
  }
}
