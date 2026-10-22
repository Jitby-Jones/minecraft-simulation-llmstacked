package agora.skins;

import com.destroystokyo.paper.profile.PlayerProfile;
import com.destroystokyo.paper.profile.ProfileProperty;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.command.RemoteConsoleCommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Puts each agent's skin on it as it logs in (agora DESIGN.md section 16.5). The Hub writes skins.tsv in this
 * plugin's folder (username, the signed textures value, its signature); in offline mode nobody has a skin
 * otherwise. "agoraskins reload", from the server console only, applies the file to those already online.
 */
public final class AgoraSkins extends JavaPlugin implements Listener {
  private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_]{1,16}");
  private static final Pattern BASE64 = Pattern.compile("[A-Za-z0-9+/]{1,32768}={0,2}");

  private Map<String, ProfileProperty> skins = Map.of();
  private long loadedStamp = Long.MIN_VALUE;

  /** Parses skins.tsv: one "username TAB value TAB signature" per line; # comments and bad lines are skipped. */
  static Map<String, ProfileProperty> parse(Iterable<String> lines) {
    Map<String, ProfileProperty> out = new HashMap<>();
    for (String line : lines) {
      if (line.isBlank() || line.startsWith("#")) continue;
      String[] f = line.split("\t", -1);
      if (f.length != 3) continue;
      if (!NAME.matcher(f[0]).matches() || !BASE64.matcher(f[1]).matches() || !BASE64.matcher(f[2]).matches()) continue;
      out.put(f[0].toLowerCase(Locale.ROOT), new ProfileProperty("textures", f[1], f[2]));
    }
    return out;
  }

  /** The skins on file, read again whenever the file changed. Logins come in on async threads. */
  private synchronized Map<String, ProfileProperty> current() {
    File file = new File(getDataFolder(), "skins.tsv");
    long stamp = file.isFile() ? file.lastModified() * 31 + file.length() : 0;
    if (stamp == loadedStamp) return skins;
    try {
      skins = stamp == 0 ? Map.of() : parse(Files.readAllLines(file.toPath(), StandardCharsets.UTF_8));
      loadedStamp = stamp;
    } catch (IOException e) {
      getLogger().warning("could not read " + file + ": " + e.getMessage());
    }
    return skins;
  }

  @Override
  public void onEnable() {
    if (!getDataFolder().isDirectory() && !getDataFolder().mkdirs()) getLogger().warning("could not create " + getDataFolder());
    getServer().getPluginManager().registerEvents(this, this);
    getLogger().info("Agents' skins: " + current().size() + " on file");
  }

  @EventHandler(priority = EventPriority.HIGH)
  public void onPreLogin(AsyncPlayerPreLoginEvent event) {
    if (event.getLoginResult() != AsyncPlayerPreLoginEvent.Result.ALLOWED) return;
    ProfileProperty skin = current().get(event.getName().toLowerCase(Locale.ROOT));
    if (skin == null) return;
    PlayerProfile profile = event.getPlayerProfile();
    profile.setProperty(skin);
    event.setPlayerProfile(profile);
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (!(sender instanceof ConsoleCommandSender) && !(sender instanceof RemoteConsoleCommandSender)) {
      sender.sendMessage("Only the server console can do that.");
      return true;
    }
    if (args.length != 1 || !args[0].equalsIgnoreCase("reload")) return false;
    Map<String, ProfileProperty> now;
    synchronized (this) {
      loadedStamp = Long.MIN_VALUE;
      now = current();
    }
    int applied = 0;
    for (Player player : getServer().getOnlinePlayers()) {
      ProfileProperty skin = now.get(player.getName().toLowerCase(Locale.ROOT));
      if (skin == null) continue;
      PlayerProfile profile = player.getPlayerProfile();
      if (profile.getProperties().contains(skin)) continue;
      profile.setProperty(skin);
      // Re-sends the player to everyone who can see them, with the new skin.
      player.setPlayerProfile(profile);
      applied++;
    }
    sender.sendMessage("AgoraSkins: " + now.size() + " on file, " + applied + " applied to players online");
    return true;
  }
}
