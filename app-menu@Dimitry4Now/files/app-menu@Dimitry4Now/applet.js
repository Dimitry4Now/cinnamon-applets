const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Util = imports.misc.util;
const Cinnamon = imports.gi.Cinnamon;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gettext = imports.gettext;

const UUID = 'app-menu@Dimitry4Now';
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _(text) {
    return Gettext.dgettext(UUID, text);
}

// Windows that belong to an app; anything else (docks, launchers, shell popups) keeps the previous app shown.
const APP_WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

// Shows the focused application's icon and name in the panel, macOS style,
// with a menu of window and app actions.
class AppMenuApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._tracker = Cinnamon.WindowTracker.get_default();
        this._window = null;
        this._app = null;
        this._unmanagedId = 0;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind('show-icon', 'showIcon', () => this._update());

        this._applet_label.add_style_class_name('app-menu-label');

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        // Focus changes are ignored while the menu is open (it acts on the window it was opened for).
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                this._onFocusChanged();
        });

        this._signals = [
            [global.display, global.display.connect('notify::focus-window', () => this._onFocusChanged())],
            [this._tracker, this._tracker.connect('notify::focus-app', () => this._onFocusChanged())],
        ];
        this._onFocusChanged();
    }

    on_applet_clicked() {
        if (!this.menu.isOpen)
            this._buildMenu();
        this.menu.toggle();
    }

    on_panel_height_changed() {
        this._update();
    }

    on_applet_removed_from_panel() {
        for (let [object, id] of this._signals)
            object.disconnect(id);
        this._setWindow(null);
    }

    _onFocusChanged() {
        if (this.menu.isOpen)
            return;

        let window = global.display.focus_window;
        if (window && window.get_window_type() === Meta.WindowType.DESKTOP)
            window = null;
        else if (window && (window.skip_taskbar || !APP_WINDOW_TYPES.includes(window.get_window_type())))
            return;
        this._setWindow(window);
    }

    _setWindow(window) {
        if (this._window && this._unmanagedId)
            this._window.disconnect(this._unmanagedId);
        this._unmanagedId = 0;

        this._window = window;
        this._app = window ? this._tracker.get_window_app(window) : null;
        if (window) {
            this._unmanagedId = window.connect('unmanaged', () => {
                this._unmanagedId = 0;
                this._window = null;
                this._app = null;
                this._update();
            });
        }
        this._update();
    }

    _appName() {
        if (!this._window)
            return _('Desktop');
        if (this._app)
            return this._app.get_name();
        return this._window.get_wm_class() || this._window.get_title() || _('Unknown');
    }

    _update() {
        let size = this.getPanelIconSize(St.IconType.FULLCOLOR);
        let icon = null;
        if (!this._window)
            icon = new St.Icon({ icon_name: 'user-desktop', icon_type: St.IconType.FULLCOLOR, icon_size: size });
        else if (this._app)
            icon = this._app.create_icon_texture_for_window(size, this._window);

        this._applet_icon_box.set_child(icon);
        this._applet_icon_box.visible = this.showIcon && icon !== null;
        this.set_applet_label(this._appName());
    }

    _addAction(label, iconName, callback, sensitive = true) {
        let item = new PopupMenu.PopupIconMenuItem(label, iconName, St.IconType.SYMBOLIC);
        item.setSensitive(sensitive);
        item.connect('activate', callback);
        this.menu.addMenuItem(item);
        return item;
    }

    _addToggle(label, iconName, active, callback) {
        let item = new PopupMenu.PopupSwitchIconMenuItem(label, active, iconName, St.IconType.SYMBOLIC);
        item.connect('toggled', (item, state) => callback(state));
        this.menu.addMenuItem(item);
    }

    _buildMenu() {
        this.menu.removeAll();

        if (!this._window) {
            this._addAction(_('Open Home Folder'), 'user-home-symbolic',
                () => Util.spawn(['xdg-open', GLib.get_home_dir()]));
            this._addAction(_('System Settings'), 'preferences-system-symbolic',
                () => Util.spawn(['cinnamon-settings']));
            return;
        }

        let window = this._window;
        let app = this._app;
        let name = this._appName();

        if (app && app.can_open_new_window()) {
            this._addAction(_('New Window'), 'window-new-symbolic', () => app.open_new_window(-1));
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        this._addAction(_('Minimize'), 'window-minimize-symbolic', () => window.minimize(), window.can_minimize());
        if (window.get_maximized() === Meta.MaximizeFlags.BOTH)
            this._addAction(_('Restore'), 'window-restore-symbolic',
                () => window.unmaximize(Meta.MaximizeFlags.BOTH), window.can_maximize());
        else
            this._addAction(_('Maximize'), 'window-maximize-symbolic',
                () => window.maximize(Meta.MaximizeFlags.BOTH), window.can_maximize());

        this._addToggle(_('Always on Top'), 'go-top-symbolic', window.is_above(),
            on => on ? window.make_above() : window.unmake_above());
        this._addToggle(_('On All Workspaces'), 'view-pin-symbolic', window.is_on_all_workspaces(),
            on => on ? window.stick() : window.unstick());

        let workspaces = global.workspace_manager.n_workspaces;
        if (workspaces > 1 && !window.is_on_all_workspaces()) {
            let current = window.get_workspace().index();
            let submenu = new PopupMenu.PopupSubMenuMenuItem(_('Move to Workspace'));
            // PopupSubMenuMenuItem has no icon slot; rebuild its row so it lines up with the icon items.
            submenu.removeActor(submenu.label);
            submenu.removeActor(submenu._triangleBin);
            submenu.addActor(new St.Icon({
                icon_name: 'view-grid-symbolic', icon_type: St.IconType.SYMBOLIC, style_class: 'popup-menu-icon',
            }), { span: 0 });
            submenu.addActor(submenu.label);
            submenu.addActor(submenu._triangleBin, { expand: true, span: -1, align: St.Align.END });
            for (let i = 0; i < workspaces; i++) {
                let item = new PopupMenu.PopupMenuItem(Main.getWorkspaceName(i));
                item.setSensitive(i !== current);
                item.connect('activate',
                    () => window.change_workspace(global.workspace_manager.get_workspace_by_index(i)));
                submenu.menu.addMenuItem(item);
            }
            this.menu.addMenuItem(submenu);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addAction(_('Close Window'), 'window-close-symbolic',
            () => window.delete(global.get_current_time()));
        if (app)
            this._addAction(_('Quit %s').format(name), 'application-exit-symbolic', () => app.request_quit());
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new AppMenuApplet(metadata, orientation, panelHeight, instanceId);
}
