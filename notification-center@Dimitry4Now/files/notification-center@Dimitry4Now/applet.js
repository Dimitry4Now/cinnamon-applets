const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Util = imports.misc.util;
const MessageTray = imports.ui.messageTray;
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gettext = imports.gettext;

const UUID = 'notification-center@Dimitry4Now';
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _(text) {
    return Gettext.dgettext(UUID, text);
}

function ngettext(singular, plural, n) {
    return Gettext.dngettext(UUID, singular, plural, n);
}

const TOOLTIP_FORMAT = '%A, %B %-e, %Y';

function relativeTime(date) {
    let seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60)
        return _('now');
    let minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return ngettext('%d min ago', '%d min ago', minutes).format(minutes);
    let hours = Math.floor(minutes / 60);
    if (hours < 24)
        return ngettext('%d hour ago', '%d hours ago', hours).format(hours);
    return date.toLocaleFormat('%b %-e, %H:%M');
}

// The panel clock, macOS style: clicking it opens the notification list.
// Takes the "notifications" role, so it replaces Cinnamon's Notifications applet.
class NotificationCenterApplet extends Applet.TextApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._notifications = [];   // newest first
        this._unread = 0;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind('clock-format', 'clockFormat', () => this._onFormatChanged());
        this.settings.bind('ignore-transient', 'ignoreTransient');
        this.settings.bind('show-unread-dot', 'showUnreadDot', () => this._sync());
        this.settings.bind('key-open', 'keyOpen', () => this._setKeybindings());
        this.settings.bind('key-clear', 'keyClear', () => this._setKeybindings());

        this._dot = new St.Widget({ style_class: 'nc-unread-dot', y_align: Clutter.ActorAlign.CENTER, visible: false });
        this.actor.add_child(this._dot);

        this._clock = new CinnamonDesktop.WallClock();
        this._clockId = this._clock.connect('notify::clock', () => this._updateClock());
        this._onFormatChanged();

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.box.add_style_class_name('nc-menu');
        this.menuManager.addMenu(this.menu);
        this._buildMenu();
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._unread = 0;
                this._updateTimestamps();
                this._sync();
            }
        });

        this._trayId = Main.messageTray.connect('notify-applet-update', (tray, notification) => this._onNotification(notification));
        this._setKeybindings();
        this._sync();
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        Main.messageTray.disconnect(this._trayId);
        this._clock.disconnect(this._clockId);
        Main.keybindingManager.removeHotKey(`notification-center-open-${this.instance_id}`);
        Main.keybindingManager.removeHotKey(`notification-center-clear-${this.instance_id}`);
    }

    _setKeybindings() {
        Main.keybindingManager.addHotKey(`notification-center-open-${this.instance_id}`, this.keyOpen, () => this.menu.toggle());
        Main.keybindingManager.addHotKey(`notification-center-clear-${this.instance_id}`, this.keyClear, () => this._clearAll());
    }

    // Clock

    _onFormatChanged() {
        if (!this._clock.set_format_string(this.clockFormat)) {
            global.logError(`${UUID}: invalid clock format "${this.clockFormat}"`);
            this._clock.set_format_string(null);
        }
        this._updateClock();
    }

    _updateClock() {
        this.set_applet_label(this._clock.get_clock());
        this.set_applet_tooltip(this._clock.get_clock_for_format(TOOLTIP_FORMAT));
    }

    // Popup

    _buildMenu() {
        let view = new St.BoxLayout({ vertical: true, style_class: 'nc-view' });

        let header = new St.BoxLayout({ style_class: 'nc-header' });
        header.add_child(new St.Label({ text: _('Notifications'), style_class: 'nc-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        this._clearButton = new St.Button({ style_class: 'nc-text-button', can_focus: true, label: _('Clear All') });
        this._clearButton.connect('clicked', () => this._clearAll());
        header.add_child(this._clearButton);

        this._list = new St.BoxLayout({ vertical: true, style_class: 'nc-list' });
        this._scroll = new St.ScrollView({
            style_class: 'nc-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.add_actor(this._list);
        // Let the scrollbar be dragged while the menu has its grab.
        let vscroll = this._scroll.get_vscroll_bar();
        vscroll.connect('scroll-start', () => this.menu.passEvents = true);
        vscroll.connect('scroll-stop', () => this.menu.passEvents = false);

        this._empty = new St.BoxLayout({ vertical: true, style_class: 'nc-empty', x_align: Clutter.ActorAlign.CENTER });
        this._empty.add_child(new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 32,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._empty.add_child(new St.Label({ text: _('No Notifications'), x_align: Clutter.ActorAlign.CENTER }));

        let footer = new St.BoxLayout({ style_class: 'nc-footer' });
        footer.add_child(new St.Widget({ x_expand: true }));
        let settingsButton = new St.Button({ style_class: 'nc-text-button', can_focus: true, label: _('Notification Settings…') });
        settingsButton.connect('clicked', () => {
            this.menu.close();
            Util.spawnCommandLine('cinnamon-settings notifications');
        });
        footer.add_child(settingsButton);

        view.add_child(header);
        view.add_child(this._empty);
        view.add_child(this._scroll);
        view.add_child(footer);
        this.menu.addActor(view);
    }

    // Notifications (same hand-off as Cinnamon's Notifications applet)

    _onNotification(notification) {
        if (this.ignoreTransient && notification.isTransient) {
            notification.destroy();
            return;
        }

        notification.actor.unparent();
        if (this._notifications.includes(notification)) {
            // Already listed: the tray hands it back after showing it again.
            if (notification._destroyed) {
                this._notifications.splice(this._notifications.indexOf(notification), 1);
            } else {
                notification._inNotificationBin = true;
                global.reparentActor(notification.actor, this._list);
                this._list.set_child_at_index(notification.actor, this._notifications.indexOf(notification));
            }
            this._sync();
            return;
        }
        if (notification._destroyed)
            return;

        notification._inNotificationBin = true;
        this._notifications.unshift(notification);
        this._list.insert_child_at_index(notification.actor, 0);
        notification.actor._parent_container = this._list;
        // Card styling only while in the list: the tray may take the actor back to show it as a banner.
        notification.actor.connect('parent-set', () => this._styleCard(notification));
        this._styleCard(notification);
        notification.connect('scrolling-changed', (n, scrolling) => this.menu.passEvents = scrolling);
        notification.connect('destroy', () => {
            let index = this._notifications.indexOf(notification);
            if (index !== -1)
                this._notifications.splice(index, 1);
            this._sync();
        });
        notification._timeLabel.show();
        notification._timeLabel.clutter_text.set_markup(relativeTime(notification._timestamp));

        if (!this.menu.isOpen)
            this._unread++;
        this._sync();
    }

    // The card itself is the actor named "notification"; it is styled directly (see stylesheet.css).
    _styleCard(notification) {
        let inList = notification.actor.get_parent() === this._list;
        for (let [actor, styleClass] of [[notification.actor, 'nc-item'], [notification.actor.get_child(), 'nc-card']]) {
            if (inList)
                actor.add_style_class_name(styleClass);
            else
                actor.remove_style_class_name(styleClass);
        }
    }

    _updateTimestamps() {
        for (let notification of this._notifications)
            notification._timeLabel.clutter_text.set_markup(relativeTime(notification._timestamp));
    }

    _clearAll() {
        for (let notification of [...this._notifications]) {
            this._list.remove_actor(notification.actor);
            notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        }
        this._notifications = [];
        this._unread = 0;
        this._sync();
    }

    _sync() {
        let count = this._notifications.length;
        this._unread = Math.min(this._unread, count);
        this._empty.visible = count === 0;
        this._scroll.visible = count > 0;
        this._clearButton.visible = count > 0;
        this._dot.visible = this.showUnreadDot && this._unread > 0;
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new NotificationCenterApplet(metadata, orientation, panelHeight, instanceId);
}
