// Test CA only. Reads public SDK assets and CMS; never opens a private key.
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.Provider;
import java.security.Security;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509CRL;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.Date;
import java.util.HexFormat;
import java.util.List;
import java.util.Arrays;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import kz.gov.pki.kalkan.asn1.ASN1InputStream;
import kz.gov.pki.kalkan.asn1.ASN1OctetString;
import kz.gov.pki.kalkan.asn1.DERInteger;
import kz.gov.pki.kalkan.asn1.x509.X509Name;
import kz.gov.pki.kalkan.jce.provider.KalkanProvider;
import kz.gov.pki.provider.utils.CMSUtil;
import kz.gov.pki.provider.utils.verifier.VerifierFlags;

public final class CmsVerifier {
  static final Provider PROVIDER = new KalkanProvider();
  static { Security.addProvider(PROVIDER); }
  static final String SIGNING_EKU = "1.3.6.1.5.5.7.3.4";
  // Approved public TEST CA snapshot. Pinning prevents SDK-path/config mistakes;
  // these hashes identify the local assets, not independent archive provenance.
  static final String TEST_ROOT = "b995e79e7c07429f8f79e185451e5599ce342ac720000f01b3854fdfa03031a6";
  static final String TEST_ISSUER = "beeffc0bdb77cd798c35983eb0715f6ef0051cccb71d7cd05505e8a4fb2c6f4d";
  static String stage = "test_ca";

  record Assets(X509Certificate root, X509Certificate ca, List<X509CRL> crls,
                long validUntil) {}
  record Receipt(String certificateDigest, long validUntil) {}
  record SubjectIdentity(String personId, String organizationId) {}

  // Identity evidence only, never organization powers. Caller provisions one
  // stable protected key; no raw IIN/BIN, DN or unkeyed identifier hash output.
  static SubjectIdentity subjectIdentity(byte[] subjectDer, byte[] key) throws Exception {
    check(key.length == 32);
    X509Name subject;
    try (var input = new ASN1InputStream(subjectDer)) {
      subject = X509Name.getInstance(input.readObject());
      check(input.readObject() == null);
    }
    var countries = subject.getValues(X509Name.C);
    var people = subject.getValues(X509Name.SERIALNUMBER);
    var units = subject.getValues(X509Name.OU);
    var names = subject.getValues(X509Name.O);
    check(countries.size() == 1 && countries.get(0).equals("KZ"));
    check(people.size() == 1 && people.get(0).toString().matches("IIN[0-9]{12}"));
    check(units.size() <= 1);
    if (units.isEmpty()) check(names.isEmpty()); // no silent downgrade of organization context
    else check(units.get(0).toString().matches("BIN[0-9]{12}") && names.size() == 1 &&
        !names.get(0).toString().isBlank());
    return new SubjectIdentity(subjectId("person", people.get(0).toString(), key),
        units.isEmpty() ? null : subjectId("organization", units.get(0).toString(), key));
  }

  private static String subjectId(String kind, String identifier, byte[] key) throws Exception {
    var mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    String domain = "dalahold:nca:TEST:identity:v1\0" + TEST_ISSUER + "\0" + kind + "\0";
    return kind + ":" + HexFormat.of().formatHex(mac.doFinal(
        (domain + identifier).getBytes(StandardCharsets.US_ASCII)));
  }

  static void check(boolean condition) {
    if (!condition) throw new IllegalArgumentException("test verification rejected");
  }

  static String digest(X509Certificate certificate) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
  }

  private static X509Certificate certificate(CertificateFactory factory, Path path)
      throws Exception {
    try (var input = Files.newInputStream(path)) {
      return (X509Certificate) factory.generateCertificate(input);
    }
  }

  private static X509CRL crl(CertificateFactory factory, Path path) throws Exception {
    try (var input = Files.newInputStream(path)) {
      return (X509CRL) factory.generateCRL(input);
    }
  }

  private static java.math.BigInteger crlNumber(X509CRL crl, String oid) throws Exception {
    try (var outer = new ASN1InputStream(crl.getExtensionValue(oid))) {
      byte[] value = ((ASN1OctetString) outer.readObject()).getOctets();
      try (var inner = new ASN1InputStream(value)) {
        return ((DERInteger) inner.readObject()).getPositiveValue();
      }
    }
  }

  // Kalkan verifies the GOST2015 TBS bytes; JDK's verify rejects its parameters.
  static void checkSignature(String algorithm, java.security.PublicKey key,
      byte[] bytes, byte[] signature) throws Exception {
    var verifier = Signature.getInstance(algorithm, PROVIDER);
    verifier.initVerify(key);
    verifier.update(bytes);
    check(verifier.verify(signature));
  }

  static Assets assets(Path sdk, Date now) throws Exception {
    return assets(sdk, sdk.resolve("Keys and Certs/CRL"), now);
  }

  static Assets testChain(Path sdk, Date now) throws Exception {
    stage = "test_ca";
    var factory = CertificateFactory.getInstance("X.509", PROVIDER);
    Path directory = sdk.resolve("Keys and Certs");
    var root = certificate(factory, directory.resolve("CA_Test/ROOT/root_test_gost_2022.cer"));
    var ca = certificate(factory, directory.resolve("CA_Test/NCA/nca_gost2022_test.cer"));
    check(digest(root).equals(TEST_ROOT) && digest(ca).equals(TEST_ISSUER));
    root.checkValidity(now);
    ca.checkValidity(now);
    check(root.getBasicConstraints() >= 0 && ca.getBasicConstraints() >= 0);
    check(root.getSubjectX500Principal().equals(root.getIssuerX500Principal()));
    check(ca.getIssuerX500Principal().equals(root.getSubjectX500Principal()));
    for (var certificate : List.of(root, ca)) {
      boolean[] usage = certificate.getKeyUsage();
      check(usage != null && usage.length > 6 && usage[5] && usage[6]);
      checkSignature(certificate.getSigAlgName(), root.getPublicKey(),
          certificate.getTBSCertificate(), certificate.getSignature());
    }
    return new Assets(root, ca, List.of(),
        Math.min(root.getNotAfter().getTime(), ca.getNotAfter().getTime()));
  }

  static Assets assets(Path sdk, Path crlDirectory, Date now) throws Exception {
    var chain = testChain(sdk, now);
    var root = chain.root();
    var ca = chain.ca();
    var factory = CertificateFactory.getInstance("X.509", PROVIDER);
    stage = "crl_files";
    var base = crl(factory, crlDirectory.resolve("nca_gost2022_test.crl"));
    var delta = crl(factory, crlDirectory.resolve("nca_gost2022_d_test.crl"));
    stage = "crl_pair";
    check(base.getExtensionValue("2.5.29.27") == null);
    check(delta.getExtensionValue("2.5.29.27") != null);
    var baseNumber = crlNumber(base, "2.5.29.20");
    check(crlNumber(delta, "2.5.29.27").compareTo(baseNumber) <= 0 &&
        crlNumber(delta, "2.5.29.20").compareTo(baseNumber) > 0);
    check(Arrays.equals(base.getExtensionValue("2.5.29.28"), delta.getExtensionValue("2.5.29.28")));
    var crls = List.of(base, delta);
    long until = Math.min(root.getNotAfter().getTime(), ca.getNotAfter().getTime());
    for (var list : crls) {
      stage = "crl_time_or_issuer";
      check(list.getIssuerX500Principal().equals(ca.getSubjectX500Principal()));
      check(!list.getThisUpdate().after(now) && list.getNextUpdate() != null &&
          list.getNextUpdate().after(now));
      stage = "crl_signature";
      checkSignature(list.getSigAlgName(), ca.getPublicKey(), list.getTBSCertList(),
          list.getSignature());
      until = Math.min(until, list.getNextUpdate().getTime());
    }
    return new Assets(root, ca, crls, until);
  }

  static X509Certificate verifiedSigner(byte[] cms, byte[] bytes, Assets assets, Date now)
      throws Exception {
    check(bytes.length > 0 && bytes.length <= 8192 && cms.length > 0 && cms.length <= 98304);
    check(assets.validUntil() > now.getTime());
    var parsed = CMSUtil.parseAsCMS(cms);
    check(parsed.getSignedContent() == null);
    check(CMSUtil.getSignerInformations(parsed).size() == 1);
    var certificates = CMSUtil.getSignerCertificates(parsed, PROVIDER);
    check(certificates.size() == 1);
    var signer = certificates.get(0);
    signer.checkValidity(now);
    check(signer.getBasicConstraints() < 0);
    check(signer.getIssuerX500Principal().equals(assets.ca().getSubjectX500Principal()));
    boolean[] usage = signer.getKeyUsage();
    check(usage != null && usage.length > 1 && (usage[0] || usage[1]));
    var eku = signer.getExtendedKeyUsage();
    check(eku != null && eku.contains(SIGNING_EKU));
    var critical = signer.getCriticalExtensionOIDs();
    check(critical == null || Set.of("2.5.29.19", "2.5.29.15", "2.5.29.37").containsAll(critical));
    checkSignature(signer.getSigAlgName(), assets.ca().getPublicKey(),
        signer.getTBSCertificate(), signer.getSignature());
    CMSUtil.verifyCMS(cms, bytes, PROVIDER);
    return signer;
  }

  static Receipt receipt(X509Certificate signer, Assets assets, long statusUntil) throws Exception {
    return new Receipt(digest(signer), Math.min(statusUntil,
        Math.min(assets.validUntil(), signer.getNotAfter().getTime())));
  }

  static Receipt verify(byte[] cms, byte[] bytes, Assets assets, Date now) throws Exception {
    check(assets.crls().size() == 2);
    var signer = verifiedSigner(cms, bytes, assets, now);
    for (var list : assets.crls()) check(!list.isRevoked(signer));
    var results = CMSUtil.verifyCMS(cms, bytes, new VerifierFlags(VerifierFlags.SIGNATURE),
        List.of(assets.ca()), assets.crls(), PROVIDER);
    check(results.size() == 1);
    var result = results.iterator().next();
    check(result.isValid() && result.getVerifyX509CertifcateResult().isValid());
    check(signer.equals(result.getVerifyX509CertifcateResult().getX509Certificate()));
    return receipt(signer, assets, assets.validUntil());
  }

  private static String pem(X509Certificate certificate) throws Exception {
    return "-----BEGIN CERTIFICATE-----\\n" +
        Base64.getEncoder().encodeToString(certificate.getEncoded()) +
        "\\n-----END CERTIFICATE-----";
  }

  public static void main(String[] args) {
    String error = "status_unavailable";
    try {
      check(args.length == 3);
      check(List.of("inspect", "verify", "inspect_ocsp", "verify_ocsp",
          "verify_identity", "verify_identity_ocsp").contains(args[2]));
      boolean identityRequested = args[2].startsWith("verify_identity");
      Path sdk = Path.of(args[0]);
      boolean ocsp = args[2].endsWith("_ocsp");
      String source = ocsp ? "test_ocsp" : "test_crl_fixture";
      Assets assets = ocsp ? testChain(sdk, new Date()) : assets(sdk, Path.of(args[1]), new Date());
      if (args[2].startsWith("inspect")) {
        // OCSP readiness covers local trust/config only, not any leaf status.
        System.out.println("{\"ready\":true,\"statusSource\":\"" + source + "\",\"validUntil\":" +
            assets.validUntil() + ",\"chain\":[\"" + pem(assets.ca()) + "\",\"" +
            pem(assets.root()) + "\"]}");
        return;
      }
      error = "signature_rejected";
      stage = "cms";
      var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.US_ASCII));
      String bytes = input.readLine();
      String cms = input.readLine();
      check(bytes != null && bytes.length() <= 12000 && cms != null && cms.length() <= 131072);
      byte[] identityKey = null;
      if (identityRequested) {
        String encodedKey = input.readLine();
        check(encodedKey != null && encodedKey.length() == 44);
        identityKey = Base64.getDecoder().decode(encodedKey);
        check(identityKey.length == 32 && Base64.getEncoder().encodeToString(identityKey).equals(encodedKey));
      }
      check(input.readLine() == null);
      byte[] signed = Base64.getDecoder().decode(cms), exact = Base64.getDecoder().decode(bytes);
      Receipt receipt;
      X509Certificate identitySigner = null;
      if (ocsp) {
        var signer = verifiedSigner(signed, exact, assets, new Date());
        stage = "ocsp";
        error = "status_unavailable";
        receipt = receipt(signer, assets, OcspVerifier.online(signer, assets.ca()));
        identitySigner = signer;
      } else receipt = verify(signed, exact, assets, new Date());
      String identityJson = "";
      if (identityRequested) {
        stage = "subject_identity";
        error = "identity_rejected";
        try {
          // CRL verify has already passed; extract only the same verified leaf.
          if (identitySigner == null) identitySigner = verifiedSigner(signed, exact, assets, new Date());
          var identity = subjectIdentity(identitySigner.getSubjectX500Principal().getEncoded(), identityKey);
          check(receipt.validUntil() > System.currentTimeMillis());
          identityJson = ",\"identity\":{\"schema\":\"nca_test_subject_v1\",\"personId\":\"" +
              identity.personId() + "\",\"organizationId\":" +
              (identity.organizationId() == null ? "null" : "\"" + identity.organizationId() + "\"") + "}";
        } finally { Arrays.fill(identityKey, (byte) 0); }
      }
      System.out.println("{\"verified\":true,\"certificateDigest\":\"" +
          receipt.certificateDigest() + "\",\"validUntil\":" + receipt.validUntil() +
          ",\"statusSource\":\"" + source + "\"" + identityJson + "}");
    } catch (Exception failure) {
      // Never print SDK exceptions: they can contain certificate subject data.
      System.out.println("{\"verified\":false,\"error\":\"" + error +
          "\",\"reason\":\"" + (stage.equals("ocsp") ? OcspVerifier.stage : stage) + "\"}");
    }
  }
}
