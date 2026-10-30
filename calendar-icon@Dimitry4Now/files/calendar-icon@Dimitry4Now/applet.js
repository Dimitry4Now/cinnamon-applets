const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Util = imports.misc.util;
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Gettext = imports.gettext;

// Reuse the month view and event list from Cinnamon's own Calendar applet, so they keep the
// theme's calendar styling and the events from cinnamon-calendar-server.
const STOCK_CALENDAR = '/usr/share/cinnamon/applets/calendar@cinnamon.org';
const Calendar = require(`${STOCK_CALENDAR}/calendar`);
const EventView = require(`${STOCK_CALENDAR}/eventView`);

const UUID = 'calendar-icon@Dimitry4Now';
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _(text) {
    return Gettext.dgettext(UUID, text);
}

const DAY_FORMAT = '%A';
const DATE_FORMAT = '%B %-e, %Y';
const TOOLTIP_FORMAT = '%A, %B %-e, %Y';

// A calendar icon for the panel; the clock itself lives in Notification Center.
class CalendarIconApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.set_applet_icon_symbolic_name('x-office-calendar-symbolic');

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.desktopSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.interface' });
        this.settings.bind('show-events', 'showEvents', () => this._syncEvents());
        this.settings.bind('key-open', 'keyOpen', () => this._setKeybinding());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.setCustomStyleClass('calendar-background');
        this.menuManager.addMenu(this.menu);
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._goToToday();
        });

        this._eventsManager = new EventView.EventsManager(this.settings, this.desktopSettings);
        this._eventsManager.connect('events-manager-ready', () => this._syncEvents());
        this._eventsManager.connect('has-calendars-changed', () => this._syncEvents());
        this._buildMenu();

        this._clock = new CinnamonDesktop.WallClock();
        this._clockId = this._clock.connect('notify::clock', () => this._updateDate());
        this._setKeybinding();
    }

    on_applet_added_to_panel() {
        this._eventsManager.start_events();
        this._goToToday();
        this._syncEvents();
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        Main.keybindingManager.removeHotKey(`calendar-icon-open-${this.instance_id}`);
        this._clock.disconnect(this._clockId);
    }

    _setKeybinding() {
        Main.keybindingManager.addHotKey(`calendar-icon-open-${this.instance_id}`, this.keyOpen, () => this.menu.toggle());
    }

    // Same layout as the stock Calendar applet: event list on the left, "today" header and month on the right.
    _buildMenu() {
        let box = new St.BoxLayout({ style_class: 'calendar-main-box' });
        this.menu.addActor(box);

        this._eventList = this._eventsManager.get_event_list();
        this._eventList.connect('launched-calendar', () => this.menu.toggle());
        this._eventList.connect('start-pass-events', () => this.menu.passEvents = true);
        this._eventList.connect('stop-pass-events', () => this.menu.passEvents = false);
        box.add_actor(this._eventList.actor);

        let calendarBox = new St.BoxLayout({ vertical: true });
        this._todayButton = new St.BoxLayout({
            style_class: 'calendar-today-home-button',
            x_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            vertical: true,
        });
        this._todayButton.connect('enter-event', actor => actor.add_style_pseudo_class('hover'));
        this._todayButton.connect('leave-event', actor => actor.remove_style_pseudo_class('hover'));
        this._todayButton.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            actor.remove_style_pseudo_class('hover');
            this._goToToday();
            return Clutter.EVENT_STOP;
        });
        this._dayLabel = new St.Label({ style_class: 'calendar-today-day-label' });
        this._dateLabel = new St.Label({ style_class: 'calendar-today-date-label' });
        this._todayButton.add_actor(this._dayLabel);
        this._todayButton.add_actor(this._dateLabel);
        calendarBox.add_actor(this._todayButton);

        this._calendar = new Calendar.Calendar(this.settings, this._eventsManager);
        this._calendar.connect('selected-date-changed', () => this._updateDate());
        calendarBox.add_actor(this._calendar.actor);
        box.add_actor(calendarBox);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let settingsItem = new PopupMenu.PopupMenuItem(_('Date and Time Settings'));
        settingsItem.connect('activate', () => {
            this.menu.close();
            Util.spawnCommandLine('cinnamon-settings calendar');
        });
        this.menu.addMenuItem(settingsItem);
    }

    _goToToday() {
        this._calendar.setDate(new Date(), true);
        this._eventsManager.select_date(this._calendar.getSelectedDate(), true);
    }

    _syncEvents() {
        this._eventList.actor.visible = this._eventsManager.is_active();
        this._eventsManager.select_date(this._calendar.getSelectedDate(), true);
    }

    _updateDate() {
        let today = this._calendar.todaySelected();
        this._todayButton.reactive = !today;
        this._todayButton.set_style_class_name(today ? 'calendar-today-home-button' : 'calendar-today-home-button-enabled');

        this._dayLabel.set_text(this._clock.get_clock_for_format(DAY_FORMAT));
        this._dateLabel.set_text(this._clock.get_clock_for_format(DATE_FORMAT));
        this.set_applet_tooltip(this._clock.get_clock_for_format(TOOLTIP_FORMAT));
        this._eventsManager.select_date(this._calendar.getSelectedDate());
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new CalendarIconApplet(metadata, orientation, panelHeight, instanceId);
}
