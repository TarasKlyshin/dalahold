// Test-only comparison of two fixed bundled personal TEST fixtures. This never
// checks revocation, enrolls an identity or grants fresh authority to either key.
// Runtime verifiers do not invoke this helper; strict OCSP is tested separately.
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import kz.gov.pki.provider.utils.CMSUtil;

public final class PersonalPairFixtureProbe {
  public static void main(String[] args) {
    String phase = "input";
    char[] password = null;
    byte[] key = new byte[32];
    try {
      CmsVerifier.check(args.length == 1);
      var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
      String supplied = input.readLine();
      CmsVerifier.check(supplied != null && !supplied.isEmpty() && input.readLine() == null);
      password = supplied.toCharArray();
      Path sdk = Path.of(args[0]).toRealPath();
      new SecureRandom().nextBytes(key);
      var now = new Date();
      phase = "pinned_test_chain";
      var assets = CmsVerifier.testChain(sdk, now);
      byte[] bytes = ("DalaHold bundled personal TEST pair subject comparison only. " +
          "No login, powers, grant, wallet or transaction.").getBytes(StandardCharsets.UTF_8);
      String validPerson = null, validDigest = null, revokedDigest = null;
      boolean samePerson = false, sameCertificate = false, bothPersonal = true;
      for (String mode : List.of("sign", "revoked")) {
        phase = "bundled_test_fixture";
        // Reuse the existing realpath-confined TEST P12 selector. No arbitrary
        // key path, alternative fixture mode or identity input is accepted.
        var entity = TestCmsSigner.entity(sdk, password, mode);
        byte[] cms = CMSUtil.createCAdES(entity, bytes, false, CmsVerifier.PROVIDER).getEncoded();
        try {
          phase = "authenticate_exact_cms";
          var certificate = CmsVerifier.verifiedSigner(cms, bytes, assets, now);
          phase = "compare_personal_subjects";
          var identity = CmsVerifier.subjectIdentity(certificate.getSubjectX500Principal().getEncoded(), key);
          String digest = CmsVerifier.digest(certificate);
          bothPersonal &= identity.organizationId() == null;
          if (mode.equals("sign")) {
            validPerson = identity.personId();
            validDigest = digest;
          } else {
            revokedDigest = digest;
            samePerson = validPerson.equals(identity.personId());
            sameCertificate = validDigest.equals(digest);
          }
        } finally { Arrays.fill(cms, (byte) 0); }
      }
      // No raw subject, identifier, pseudonym, mapping key or CMS is emitted.
      System.out.println("{\"identityEvidence\":\"ca_authenticated_cms_subject_comparison_only\"," +
          "\"samePerson\":" + samePerson + ",\"sameCertificate\":" + sameCertificate +
          ",\"bothPersonalSubjects\":" + bothPersonal + ",\"validDigest\":\"" + validDigest +
          "\",\"revokedDigest\":\"" + revokedDigest + "\"}");
    } catch (Exception error) {
      // SDK exceptions can contain subject data; only fixed phase/type escapes.
      System.out.println("{\"fixtureProbeRejected\":true,\"phase\":\"" + phase +
          "\",\"type\":\"" + error.getClass().getSimpleName() + "\"}");
    } finally {
      if (password != null) Arrays.fill(password, '\0');
      Arrays.fill(key, (byte) 0);
    }
  }
}
