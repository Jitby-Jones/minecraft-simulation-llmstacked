package agora.guard;

import java.util.Locale;
import java.util.Set;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerCommandSendEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Blocks private and global chat commands for non-ops, so all speech goes through proximity chat and
 * humans and agents can act the same way (agora DESIGN.md section 15.3). Ops (the owner) keep them.
 */
public final class AgoraGuard extends JavaPlugin implements Listener {
  private static final Set<String> BASE = Set.of("msg", "tell", "w", "me", "teammsg", "tm");

  static boolean isBlocked(String label) {
    String l = label.toLowerCase(Locale.ROOT);
    if (l.startsWith("minecraft:")) l = l.substring("minecraft:".length());
    return BASE.contains(l);
  }

  @Override
  public void onEnable() {
    getServer().getPluginManager().registerEvents(this, this);
    getLogger().info("Private chat commands are disabled for non-ops: " + BASE);
  }

  @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
  public void onCommand(PlayerCommandPreprocessEvent event) {
    Player player = event.getPlayer();
    if (player.isOp()) return;
    String message = event.getMessage();
    if (!message.startsWith("/")) return;
    int space = message.indexOf(' ');
    String label = space < 0 ? message.substring(1) : message.substring(1, space);
    if (isBlocked(label)) {
      event.setCancelled(true);
      player.sendMessage("Private messages are disabled here. Talk to people nearby instead.");
    }
  }

  @EventHandler
  public void onCommandList(PlayerCommandSendEvent event) {
    if (event.getPlayer().isOp()) return;
    event.getCommands().removeIf(AgoraGuard::isBlocked);
  }
}
