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

import kz.gov.pki.kalkan.asn1.ASN1InputStream;
import kz.gov.pki.kalkan.asn1.ASN1OctetString;
import kz.gov.pki.kalkan.asn1.DERInteger;
import kz.gov.pki.kalkan.jce.provider.KalkanProvider;
import kz.gov.pki.provider.utils.CMSUtil;
import kz.gov.pki.provider.utils.verifier.VerifierFlags;

public final class CmsVerifier {
  static final Provider PROVIDER = new KalkanProvider();
  static { Security.addProvider(PROVIDER); }
  static final String SIGNING_EKU = "1.3.6.1.5.5.7.3.4";
  static String stage = "test_ca";

  record Assets(X509Certificate root, X509Certificate ca, List<X509CRL> crls,
                long validUntil) {}
  record Receipt(String certificateDigest, long validUntil) {}

  static void check(boolean condition) {
    if (!condition) throw new IllegalArgumentException("test verification rejected");
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

  static Assets assets(Path sdk, Path crlDirectory, Date now) throws Exception {
    stage = "test_ca";
    var factory = CertificateFactory.getInstance("X.509", PROVIDER);
    Path directory = sdk.resolve("Keys and Certs");
    var root = certificate(factory, directory.resolve("CA_Test/ROOT/root_test_gost_2022.cer"));
    var ca = certificate(factory, directory.resolve("CA_Test/NCA/nca_gost2022_test.cer"));
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

  static Receipt verify(byte[] cms, byte[] bytes, Assets assets, Date now) throws Exception {
    check(bytes.length > 0 && bytes.length <= 8192 && cms.length > 0 && cms.length <= 98304);
    check(assets.validUntil() > now.getTime());
    check(assets.crls().size() == 2);
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
    checkSignature(signer.getSigAlgName(), assets.ca().getPublicKey(),
        signer.getTBSCertificate(), signer.getSignature());
    for (var list : assets.crls()) check(!list.isRevoked(signer));
    var results = CMSUtil.verifyCMS(cms, bytes, new VerifierFlags(VerifierFlags.SIGNATURE),
        List.of(assets.ca()), assets.crls(), PROVIDER);
    check(results.size() == 1);
    var result = results.iterator().next();
    check(result.isValid() && result.getVerifyX509CertifcateResult().isValid());
    check(signer.equals(result.getVerifyX509CertifcateResult().getX509Certificate()));
    String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest(signer.getEncoded()));
    return new Receipt(digest, Math.min(assets.validUntil(), signer.getNotAfter().getTime()));
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
      Path sdk = Path.of(args[0]);
      Assets assets = assets(sdk, Path.of(args[1]), new Date());
      if (args[2].equals("inspect")) {
        System.out.println("{\"ready\":true,\"statusSource\":\"test_crl_fixture\",\"validUntil\":" +
            assets.validUntil() + ",\"chain\":[\"" + pem(assets.ca()) + "\",\"" +
            pem(assets.root()) + "\"]}");
        return;
      }
      check(args[2].equals("verify"));
      error = "signature_rejected";
      stage = "cms";
      var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.US_ASCII));
      String bytes = input.readLine();
      String cms = input.readLine();
      check(bytes != null && bytes.length() <= 12000 && cms != null && cms.length() <= 131072);
      check(input.readLine() == null);
      var receipt = verify(Base64.getDecoder().decode(cms), Base64.getDecoder().decode(bytes),
          assets, new Date());
      System.out.println("{\"verified\":true,\"certificateDigest\":\"" +
          receipt.certificateDigest() + "\",\"validUntil\":" + receipt.validUntil() + "}");
    } catch (Exception failure) {
      // Never print SDK exceptions: they can contain certificate subject data.
      System.out.println("{\"verified\":false,\"error\":\"" + error +
          "\",\"reason\":\"" + stage + "\"}");
    }
  }
}
