// Synthetic subject parser checks only, not CA-authenticated identities.
import java.util.Arrays;
import kz.gov.pki.kalkan.asn1.x509.X509Name;

public final class SubjectIdentityTest {
  static int checks = 0;
  static byte[] key = new byte[32];
  static final String PERSON = "C=KZ,SERIALNUMBER=IIN000000000001,CN=Fixture";
  static final String ORGANIZATION = ",OU=BIN000000000001,O=Fixture Company";

  static CmsVerifier.SubjectIdentity identity(String dn) throws Exception {
    return CmsVerifier.subjectIdentity(new X509Name(dn).getEncoded(), key);
  }

  static void check(boolean condition) {
    CmsVerifier.check(condition); checks++;
  }

  static void rejects(String dn) throws Exception {
    boolean refused = false;
    try { identity(dn); } catch (Exception expected) { refused = true; }
    check(refused);
  }

  public static void main(String[] args) {
    try {
      Arrays.fill(key, (byte) 7);
      var person = identity(PERSON);
      var organization = identity(PERSON + ORGANIZATION);
      check(person.personId().matches("person:[a-f0-9]{64}") && person.organizationId() == null);
      check(person.personId().equals(organization.personId()));
      check(organization.organizationId().matches("organization:[a-f0-9]{64}"));
      check(!organization.personId().substring(7).equals(organization.organizationId().substring(13)));
      check(person.personId().equals(identity(PERSON.replace("Fixture", "Different Name")).personId()));
      check(!person.personId().equals(identity(PERSON.replace("000000000001", "000000000002")).personId()));
      check(organization.organizationId().equals(identity(PERSON.replace("000000000001", "000000000002") + ORGANIZATION).organizationId()));
      check(!organization.organizationId().equals(identity(PERSON + ORGANIZATION.replace("000000000001", "000000000002")).organizationId()));
      check(!person.personId().contains("000000000001"));
      Arrays.fill(key, (byte) 8);
      check(!person.personId().equals(identity(PERSON).personId()));
      Arrays.fill(key, (byte) 7);
      check(person.personId().equals(identity("CN=Different,C=KZ,SERIALNUMBER=IIN000000000001").personId()));
      check(person.personId().equals(identity("CN=IIN000000000099,C=KZ,SERIALNUMBER=IIN000000000001").personId()));
      for (String invalid : new String[] {
        "C=KZ,CN=Fixture", PERSON + ",SERIALNUMBER=IIN000000000001",
        PERSON + ",C=KZ", PERSON.replace("KZ", "RU"),
        PERSON.replace("IIN000000000001", "BIN000000000001"),
        PERSON.replace("000000000001", "00000000001"),
        PERSON.replace("IIN", "iin"), PERSON.replace("IIN", "IIN "),
        PERSON.replace("000000000001", "00000000000A"),
        PERSON.replace("000000000001", "０００００００００００１"),
        PERSON + ",OU=Sales", PERSON + ORGANIZATION + ",OU=BIN000000000001",
        PERSON + ",OU=BIN000000000001", PERSON + ",O=Fixture Company",
        PERSON + ORGANIZATION + ",O=Another Company",
        PERSON.replace("IIN000000000001", "IIN000000000001-extra"),
      }) rejects(invalid);
      boolean badKey = false;
      try { CmsVerifier.subjectIdentity(new X509Name(PERSON).getEncoded(), new byte[31]); }
      catch (Exception expected) { badKey = true; }
      check(badKey);
      boolean trailing = false;
      var der = new X509Name(PERSON).getEncoded();
      var extra = Arrays.copyOf(der, der.length + 2); extra[der.length] = 5;
      try { CmsVerifier.subjectIdentity(extra, key); }
      catch (Exception expected) { trailing = true; }
      check(trailing);
      System.out.println("{\"subjectChecks\":" + checks + ",\"passed\":true,\"syntheticOnly\":true}");
    } catch (Exception failure) {
      System.out.println("{\"passed\":false,\"subjectChecks\":" + checks + ",\"error\":\"subject_fixture\"}");
    } finally { Arrays.fill(key, (byte) 0); }
  }
}
