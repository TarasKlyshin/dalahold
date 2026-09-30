// Isolated SDK test only: uses bundled test PKCS#12 in memory and never writes
// a key, CMS container, certificate identity, or signature to disk or stdout.
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Provider;
import java.security.Security;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509CRL;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import kz.gov.pki.kalkan.jce.provider.KalkanProvider;
import kz.gov.pki.provider.utils.CMSUtil;
import kz.gov.pki.provider.utils.model.SigningEntity;
import kz.gov.pki.provider.utils.verifier.VerifierFlags;
import kz.gov.pki.provider.utils.verifier.VerifyCMSSignatureResult;

public final class SdkProbe {
  private static final byte[] CHALLENGE =
      "DalaHold isolated exact-byte SDK test v1".getBytes(StandardCharsets.UTF_8);

  private static X509Certificate certificate(CertificateFactory factory, Path path) throws Exception {
    try (var input = Files.newInputStream(path)) {
      return (X509Certificate) factory.generateCertificate(input);
    }
  }

  private static X509CRL crl(CertificateFactory factory, Path path) throws Exception {
    try (var input = Files.newInputStream(path)) {
      return (X509CRL) factory.generateCRL(input);
    }
  }

  // JDK X509Certificate/CRL.verify rejects these GOST2015 signature parameters;
  // verify the TBS bytes with the supplied Kalkan provider instead.
  private static void checkSignature(String algorithm, java.security.PublicKey key,
      byte[] signedBytes, byte[] signature, Provider provider) throws Exception {
    Signature verifier = Signature.getInstance(algorithm, provider);
    verifier.initVerify(key);
    verifier.update(signedBytes);
    if (!verifier.verify(signature)) throw new IllegalStateException("certificate signature rejected");
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 2) throw new IllegalArgumentException("SDK root and bundled test P12 required");
    Path sdk = Path.of(args[0]);
    Path p12 = Path.of(args[1]);
    if (!p12.toRealPath().startsWith(sdk.resolve("Keys and Certs/Gost2015").toRealPath())) {
      throw new IllegalArgumentException("only bundled test P12 is allowed");
    }
    Provider provider = new KalkanProvider();
    Security.addProvider(provider);
    var console = System.console();
    String piped = console == null
        ? new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine()
        : null;
    char[] password = console == null ? (piped == null ? new char[0] : piped.toCharArray())
        : console.readPassword("Bundled test P12 password: ");
    KeyStore store = KeyStore.getInstance("PKCS12", provider);
    try (var input = Files.newInputStream(p12)) { store.load(input, password); }
    String alias = null;
    for (var names = store.aliases(); names.hasMoreElements();) {
      String candidate = names.nextElement();
      if (store.isKeyEntry(candidate)) { alias = candidate; break; }
    }
    if (alias == null) throw new IllegalStateException("test key unavailable");
    PrivateKey key = (PrivateKey) store.getKey(alias, password);
    var chain = new ArrayList<X509Certificate>();
    for (var cert : store.getCertificateChain(alias)) chain.add((X509Certificate) cert);
    Arrays.fill(password, '\0');

    var signed = CMSUtil.createCAdES(new SigningEntity(key, chain), CHALLENGE, false, provider);
    byte[] cms = signed.getEncoded();
    if (CMSUtil.parseAsCMS(cms).getSignedContent() != null) {
      throw new IllegalStateException("CMS must be detached");
    }
    CMSUtil.verifyCMS(cms, CHALLENGE, provider);
    try {
      CMSUtil.verifyCMS(cms, "altered".getBytes(StandardCharsets.UTF_8), provider);
      throw new IllegalStateException("altered bytes were accepted");
    } catch (kz.gov.pki.provider.exception.ProviderUtilException expected) {
      // Exact-byte rejection is the first mandatory boundary.
    }
    System.out.println("SDK detached CMS: exact bytes accepted; altered bytes rejected");

    // Pair consistency was missing in the initial isolated probe. A fresh and
    // correctly signed delta cannot be combined with a base below BaseCRLNumber.
    CmsVerifier.assets(sdk, new java.util.Date());

    var factory = CertificateFactory.getInstance("X.509", provider);
    Path publicAssets = sdk.resolve("Keys and Certs");
    X509Certificate root = certificate(factory,
        publicAssets.resolve("CA_Test/ROOT/root_test_gost_2022.cer"));
    X509Certificate nca = certificate(factory,
        publicAssets.resolve("CA_Test/NCA/nca_gost2022_test.cer"));
    root.checkValidity();
    nca.checkValidity();
    if (!nca.getIssuerX500Principal().equals(root.getSubjectX500Principal())) {
      throw new IllegalStateException("unexpected test CA issuer");
    }
    checkSignature(root.getSigAlgName(), root.getPublicKey(), root.getTBSCertificate(),
        root.getSignature(), provider);
    checkSignature(nca.getSigAlgName(), root.getPublicKey(), nca.getTBSCertificate(),
        nca.getSignature(), provider);
    List<X509Certificate> anchors = List.of(nca);
    List<X509CRL> revocation = List.of(
        crl(factory, publicAssets.resolve("CRL/nca_gost2022_test.crl")),
        crl(factory, publicAssets.resolve("CRL/nca_gost2022_d_test.crl")));
    var now = new java.util.Date();
    for (var list : revocation) {
      if (list.getThisUpdate().after(now) || list.getNextUpdate() == null ||
          !list.getNextUpdate().after(now)) throw new IllegalStateException("test CRL stale");
      if (!list.getIssuerX500Principal().equals(nca.getSubjectX500Principal())) {
        throw new IllegalStateException("unexpected test CRL issuer");
      }
      checkSignature(list.getSigAlgName(), nca.getPublicKey(), list.getTBSCertList(),
          list.getSignature(), provider);
    }
    Set<VerifyCMSSignatureResult> results = CMSUtil.verifyCMS(
        cms, CHALLENGE, new VerifierFlags(VerifierFlags.SIGNATURE),
        anchors, revocation, provider);
    if (results.size() != 1 || !results.iterator().next().isValid() ||
        !results.iterator().next().getVerifyX509CertifcateResult().isValid()) {
      throw new IllegalStateException("SDK signature, chain or status rejected");
    }
    X509Certificate signer = results.iterator().next()
        .getVerifyX509CertifcateResult().getX509Certificate();
    if (signer == null || !signer.getIssuerX500Principal().equals(nca.getSubjectX500Principal())) {
      throw new IllegalStateException("unexpected test issuer");
    }
    signer.checkValidity();
    checkSignature(signer.getSigAlgName(), nca.getPublicKey(), signer.getTBSCertificate(),
        signer.getSignature(), provider);
    for (var list : revocation) {
      if (list.isRevoked(signer)) throw new IllegalStateException("test certificate revoked");
    }
    System.out.println("SDK test chain and bundled CRL: accepted (test fixture only)");
    boolean acceptedWithoutCrl = false;
    try {
      var withoutCrl = CMSUtil.verifyCMS(cms, CHALLENGE,
          new VerifierFlags(VerifierFlags.SIGNATURE), anchors, List.of(), provider);
      acceptedWithoutCrl = withoutCrl.size() == 1 && withoutCrl.iterator().next().isValid();
    } catch (Exception expected) {
      // A missing revocation source must never be a successful verification.
    }
    if (acceptedWithoutCrl) throw new IllegalStateException("missing CRL was accepted");
    System.out.println("SDK status check: missing CRL rejected");
  }
}
