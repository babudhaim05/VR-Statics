#if UNITY_EDITOR
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Convai.Runtime.Core.Configuration;
using Newtonsoft.Json;
using UnityEngine;

namespace VRStatics.Content.ConvaiStoryDemo
{
    // Editor-only operator helper; no secrets or long-lived credentials enter a player build.
    public static class ConvaiDemoEditorAuth
    {
        [Serializable] sealed class LocalConfig { public string node; public string workingDirectory; public string script; }
        sealed class TokenOutput { public string token; public string expirationTime; }
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void Register()
        {
            if (ConvaiAuthTokenProviderRegistry.IsRegistered) return;
            var path = ConfigurationPath();
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
            try
            {
                ConvaiAuthTokenProviderRegistry.Register(CreateProvider(path));
                UnityEngine.Debug.Log("Convai Editor authentication: fresh temporary tokens will be requested automatically for each connection.");
            }
            catch { UnityEngine.Debug.LogError("Convai Editor authentication configuration is unavailable. No credential was changed."); }
        }
        // The integrated guide can delegate GetTokenAsync to this provider without replacing its flow.
        // Its existing registry owner remains responsible for registration and scene-exit cleanup.
        public static IConvaiAuthTokenProvider CreateProvider(string configurationPath = null)
        {
            var path = configurationPath ?? ConfigurationPath();
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new InvalidOperationException("Editor issuer configuration is unavailable.");
            var config = JsonConvert.DeserializeObject<LocalConfig>(File.ReadAllText(path));
            if (config == null || !File.Exists(config.node) || !File.Exists(config.script) ||
                config.script.Contains("\"") || !Directory.Exists(config.workingDirectory) ||
                !File.Exists(Path.Combine(config.workingDirectory, ".env")))
                throw new InvalidOperationException("Editor issuer paths are unavailable.");
            return new Provider(config);
        }
        static string ConfigurationPath()
        {
            var external = Environment.GetEnvironmentVariable("VR_STATICS_EDITOR_AUTH_CONFIG");
            return !string.IsNullOrEmpty(external) ? external :
                Path.Combine(Path.GetDirectoryName(Application.dataPath), "Library", "ConvaiDemoEditorAuth.json");
        }
        sealed class Provider : IConvaiAuthTokenProvider
        {
            readonly LocalConfig config;
            public Provider(LocalConfig config) { this.config = config; }
            public Task<AuthTokenResult> GetTokenAsync(CancellationToken cancellationToken) => Task.Run(async () =>
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(65));
                using var process = new Process { StartInfo = new ProcessStartInfo
                {
                    FileName = config.node,
                    Arguments = "--env-file=.env \"" + config.script + "\"",
                    WorkingDirectory = config.workingDirectory,
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true
                } };
                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    process.Start();
                    using var cancel = timeout.Token.Register(() => { try { if (!process.HasExited) process.Kill(); } catch { } });
                    var outputTask = process.StandardOutput.ReadToEndAsync();
                    var errorTask = process.StandardError.ReadToEndAsync();
                    string output = await outputTask.ConfigureAwait(false);
                    await errorTask.ConfigureAwait(false); // deliberately never log process output
                    process.WaitForExit();
                    timeout.Token.ThrowIfCancellationRequested();
                    if (process.ExitCode != 0) return AuthTokenResult.Failed("Editor token renewal failed. Check backend availability and local issuer configuration.");
                    var result = JsonConvert.DeserializeObject<TokenOutput>(output);
                    if (result == null || string.IsNullOrWhiteSpace(result.token)) return AuthTokenResult.Failed("Editor token renewal returned no token.");
                    DateTimeOffset? expiry = DateTimeOffset.TryParse(result.expirationTime, out var parsed) ? parsed : (DateTimeOffset?)null;
                    return AuthTokenResult.Succeeded(result.token, expiry);
                }
                catch (OperationCanceledException) { throw; }
                catch { return AuthTokenResult.Failed("Editor token renewal could not start. Check the local Node and issuer paths."); }
            }, cancellationToken);
        }
    }
}
#endif
