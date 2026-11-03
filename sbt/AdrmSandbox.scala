// ADRM publisher sandbox for sbt (sbt 1.x). Installed as a global plugin (~/.sbt/1.0/plugins/AdrmSandbox.scala)
// by adrm-checks actions/sandbox, so the project's own `sbt publish` command runs unchanged.
// Every project's `publish` writes to the file repository $ADRM_SANDBOX_DIR (Maven layout) instead of the
// repository named by publishTo; the task fails if a project would still publish anywhere else.
// Covers the standard `publish` task only: publishSigned (sbt-pgp), sbt-sonatype and custom publish tasks
// are not redirected and must be added before such a project is onboarded.
import sbt._
import sbt.Keys._
import sbt.librarymanagement.ivy.InlineIvyConfiguration

object AdrmSandbox extends AutoPlugin {
  override def trigger = allRequirements
  override def requires = plugins.JvmPlugin

  object autoImport {
    val adrmSandboxDir = settingKey[File]("ADRM sandbox directory, from ADRM_SANDBOX_DIR")
    val adrmSandboxCheck = taskKey[Unit]("Fails unless publish is redirected to the ADRM sandbox")
  }
  import autoImport._

  private val ResolverName = "adrm-sandbox"

  // Read once per JVM; missing ADRM_SANDBOX_DIR must not break project loading (sbt test, compile), only publish.
  private val envDir: Option[File] = sys.env.get("ADRM_SANDBOX_DIR").filter(_.nonEmpty).map(file)

  private def resolverFor(dir: File): Resolver = Resolver.file(ResolverName, dir)(Resolver.mavenStylePatterns)

  override def projectSettings: Seq[Setting[_]] = Seq(
    adrmSandboxDir := envDir.getOrElse(file(sys.props("java.io.tmpdir")) / "adrm-sandbox-unset"),
    // Usual path: publishTo's resolver list. Builds that replace otherResolvers (e.g. Spark) are covered below.
    otherResolvers += resolverFor(adrmSandboxDir.value),
    ivyConfiguration := {
      val sandbox = resolverFor(adrmSandboxDir.value)
      ivyConfiguration.value match {
        case c: InlineIvyConfiguration if !c.otherResolvers.exists(_.name == ResolverName) =>
          c.withOtherResolvers(c.otherResolvers :+ sandbox)
        case c => c
      }
    },
    publishConfiguration := publishConfiguration.value.withResolverName(ResolverName).withOverwrite(true),
    adrmSandboxCheck := {
      val cfg = publishConfiguration.value
      val log = streams.value.log
      if (envDir.isEmpty) sys.error("ADRM sandbox: ADRM_SANDBOX_DIR is not set")
      if (cfg.resolverName != Some(ResolverName))
        sys.error(s"ADRM sandbox: project ${name.value} would publish to '${cfg.resolverName.getOrElse("<none>")}', not to the sandbox")
      if (!cfg.publishMavenStyle)
        sys.error(s"ADRM sandbox: project ${name.value} publishes Ivy-style; only Maven-style publications are supported")
      log.info(s"ADRM sandbox: ${name.value} publishes to ${adrmSandboxDir.value}")
    },
    publish := (publish dependsOn adrmSandboxCheck).value
  )
}
