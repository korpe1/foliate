/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const { GObject, Gtk, Gio, Gdk, GdkPixbuf } = imports.gi
const ngettext = imports.gettext.ngettext

const { isExternalURL, alphaColor, invertRotate, brightenColor } = imports.utils
const { EpubView, EpubViewSettings, EpubViewAnnotation } = imports.epubView
const { DictionaryBox, WikipediaBox, TranslationBox } = imports.lookup
const { tts, TtsButton } = imports.tts
const { themes, customThemes, ThemeRow, applyTheme } = imports.theme
const { exportAnnotations } = imports.export

const settings = new Gio.Settings({ schema_id: pkg.name })
const windowState = new Gio.Settings({ schema_id: pkg.name + '.window-state' })
const viewSettings = new Gio.Settings({ schema_id: pkg.name + '.view' })

const highlightColors = ['yellow', 'orange', 'red', 'magenta', 'aqua', 'lime']

const maxBy = (arr, f) =>
    arr[arr.map(f).reduce((prevI, x, i, arr) => x > arr[prevI] ? i : prevI, 0)]

const makePopoverPosition = ({ left, right, top, bottom }, window, height) => {
    const [winWidth, winHeight] = window.get_size()

    const borders = [
        [left, Gtk.PositionType.LEFT, left, (top + bottom) / 2],
        [winWidth - right, Gtk.PositionType.RIGHT, right, (top + bottom) / 2],
        [top, Gtk.PositionType.TOP, (left + right) / 2, top],
        [winHeight - bottom, Gtk.PositionType.BOTTOM, (left + right) / 2, bottom]
    ]
    const maxBorder = borders[3][0] > height ? borders[3]
        : borders[2][0] > height ? borders[2]
        : maxBy(borders, x => x[0])

    const x = maxBorder[2]
    const y = maxBorder[3]
    return {
        // sometimes the reported position values are wrong
        // setting x, y to zero insures that the popover is at least visible
        position: {
            x: x <= winWidth && x > 0 ? x : 0,
            y: y <= winHeight && y > 0 ? y : 0
        },
        positionType: maxBorder[1]
    }
}
const setPopoverPosition = (popover, position, window, height) => {
    const setPosition = height => {
        const { position: rectPosition, positionType } =
            makePopoverPosition(position, window, height)
        popover.position = positionType
        popover.pointing_to = new Gdk.Rectangle(rectPosition)
    }
    popover.connect('size-allocate', () =>
        setPosition(popover.get_allocation().height))

    setPosition(height)
}

const PropertyBox = GObject.registerClass({
    GTypeName: 'FoliatePropertyBox',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/propertyBox.ui',
    InternalChildren: ['name', 'value'],
    Properties: {
        'property-name':
            GObject.ParamSpec.string('property-name', 'property-name', 'property-name',
                GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT, ''),
        'property-value':
            GObject.ParamSpec.string('property-value', 'property-value', 'property-value',
                GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT, '')
    }
}, class PropertyBox extends Gtk.Box {
    _init(params) {
        super._init(params)
        const flag = GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE
        this.bind_property('property-name', this._name, 'label', flag)
        this.bind_property('property-value', this._value, 'label', flag)
    }
})

const PropertiesWindow = GObject.registerClass({
    GTypeName: 'FoliatePropertiesWindow',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/propertiesWindow.ui',
    InternalChildren: [
        'cover', 'title', 'creator', 'description', 'propertiesBox'
    ]
}, class PropertiesWindow extends Gtk.Dialog {
    _init(params, metadata, cover) {
        super._init(params)
        if (cover) {
            const width = 120
            const ratio = width / cover.get_width()
            const height = parseInt(cover.get_height() * ratio, 10)
            this._cover.set_from_pixbuf(cover
                .scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR))
        } else this._cover.hide()

        const {
            title, creator, description,
            publisher, pubdate, modified_date, language, identifier, rights
        } = metadata
        this._title.label = title
        this._creator.label = creator
        if (description) this._description.label = description
        else this._description.hide()
        if (publisher) this._propertiesBox.pack_start(new PropertyBox({
            property_name: _('Publisher'),
            property_value: publisher
        }), false, true, 0)
        if (pubdate) this._propertiesBox.pack_start(new PropertyBox({
            property_name: _('Publication Date'),
            property_value: pubdate
        }), false, true, 0)
        if (modified_date) this._propertiesBox.pack_start(new PropertyBox({
            property_name: _('Modified Date'),
            property_value: modified_date
        }), false, true, 0)
        if (language) this._propertiesBox.pack_start(new PropertyBox({
            property_name: _('Language'),
            property_value: language
        }), false, true, 0)
        if (identifier) this._propertiesBox.pack_start(new PropertyBox({
            property_name: _('Identifier'),
            property_value: identifier
        }), false, true, 0)
        if (rights) this._propertiesBox.pack_start(new PropertyBox({
            property_name: _('Copyright'),
            property_value: rights
        }), false, true, 0)
    }
})

const AnnotationRow = GObject.registerClass({
    GTypeName: 'FoliateAnnotationRow',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/annotationRow.ui',
    InternalChildren: [
        'annotationSection', 'annotationText', 'annotationNote'
    ]
}, class AnnotationRow extends Gtk.ListBoxRow {
    _init(annotation, epubView) {
        super._init()
        this.annotation = annotation
        this._epub = epubView

        this._annotationText.label = annotation.text
        epubView.getSectionFromCfi(annotation.cfi).then(section =>
            this._annotationSection.label = section.label)

        this._applyColor()
        annotation.connect('notify::color', this._applyColor.bind(this))

        this._applyNote()
        annotation.connect('notify::note', this._applyNote.bind(this))
    }
    _applyNote() {
        const note = this.annotation.note
        this._annotationNote.label = note.trim().replace(/\n/g, ' ')
        this._annotationNote.visible = Boolean(note)
    }
    _applyColor() {
        const cssProvider = new Gtk.CssProvider()
        cssProvider.load_from_data(`
            label {
                border-left: 7px solid ${alphaColor(this.annotation.color, 0.5)};
                padding-left: 15px;
            }`)
        const styleContext = this._annotationText.get_style_context()
        styleContext
            .add_provider(cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    }
    _remove() {
        this._epub.removeAnnotation(this.annotation)
    }
})

const BookmarkRow = GObject.registerClass({
    GTypeName: 'FoliateBookmarkRow',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/bookmarkRow.ui',
    InternalChildren: [
        'bookmarkSection', 'bookmarkText'
    ]
}, class BookmarkRow extends Gtk.ListBoxRow {
    _init(bookmark, epubView) {
        super._init()
        this.bookmark = bookmark
        this._epub = epubView

        this._bookmarkText.label = bookmark.cfi
        this._epub.getSectionFromCfi(bookmark.cfi).then(section =>
            this._bookmarkSection.label = section.label)
    }
    _remove() {
        this._epub.removeBookmark(this.bookmark.cfi)
    }
})

const ContentsStack = GObject.registerClass({
    GTypeName: 'FoliateContentsStack',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/contentsStack.ui',
    InternalChildren: [
        'tocTreeView',
        'annotationsStack', 'annotationsListBox',
        'bookmarksStack', 'bookmarksListBox', 'bookmarkButton'
    ],
    Signals: {
        'row-activated': { flags: GObject.SignalFlags.RUN_FIRST }
    }
}, class ContentsStack extends Gtk.Stack {
    _init() {
        super._init()

        this._annotationsListBox.set_header_func((row) => {
            if (row.get_index()) row.set_header(new Gtk.Separator())
        })
        this._bookmarksListBox.set_header_func((row) => {
            if (row.get_index()) row.set_header(new Gtk.Separator())
        })
    }
    set epub(epub) {
        this._epub = epub
        this._tocTreeView.model = this._epub.toc

        this._epub.connect('data-ready', (_, annotations, bookmarks) => {
            this._annotationsStack.visible_child_name =
                annotations.get_n_items() ? 'main' : 'empty'
            annotations.connect('items-changed', () => {
                this._annotationsStack.visible_child_name =
                    annotations.get_n_items() ? 'main' : 'empty'
            })
            this._annotationsListBox.bind_model(annotations, annotation =>
                new AnnotationRow(annotation, this._epub))

            this._bookmarksStack.visible_child_name =
                bookmarks.get_n_items() ? 'main' : 'empty'
            bookmarks.connect('items-changed', () => {
                this._bookmarksStack.visible_child_name =
                    bookmarks.get_n_items() ? 'main' : 'empty'
                this._updateBookmarkButton()
            })
            this._bookmarksListBox.bind_model(bookmarks, bookmark =>
                new BookmarkRow(bookmark, this._epub))
        })
        this._epub.connect('relocated', () => {
            this._updateBookmarkButton()

            // select toc item
            const { sectionHref } = this._epub.location
            const view = this._tocTreeView
            const store = view.model
            const selection = view.get_selection()
            let iter = store.get_iter_first()[1]
            loop:
            while (true) {
                const value = store.get_value(iter, 0)
                if (value === sectionHref) {
                    const path = store.get_path(iter)
                    view.expand_to_path(path)
                    view.scroll_to_cell(path, null, true, 0.5, 0)
                    selection.select_iter(iter)
                    break
                }
                const [hasChild, childIter] = store.iter_children(iter)
                if (hasChild) iter = childIter
                else {
                    while (true) {
                        const [hasParent, parentIter] = store.iter_parent(iter)
                        if (!store.iter_next(iter)) {
                            if (hasParent) iter = parentIter
                            else break loop
                        } else break
                    }
                }
            }
        })
    }
    _onTocRowActivated() {
        const store = this._tocTreeView.model
        const selection = this._tocTreeView.get_selection()
        const [, , iter] = selection.get_selected()
        const href = store.get_value(iter, 0)
        this._epub.goTo(href)
        this.emit('row-activated')
    }
    _onAnnotationRowActivated(_, row) {
        this._epub.goTo(row.annotation.cfi)
        this.emit('row-activated')
    }
    _onBookmarkRowActivated(_, row) {
        this._epub.goTo(row.bookmark.cfi)
        this.emit('row-activated')
    }
    _updateBookmarkButton() {
        if (this._epub.hasBookmark()) {
            this._bookmarkButton.tooltip_text = _('Remove current location')
            this._bookmarkButton.get_child().icon_name = 'edit-delete-symbolic'
        } else {
            this._bookmarkButton.tooltip_text = _('Bookmark current location')
            this._bookmarkButton.get_child().icon_name = 'bookmark-new-symbolic'
        }
    }
})

const FindBox = GObject.registerClass({
    GTypeName: 'FoliateFindBox',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/findBox.ui',
    InternalChildren: ['findEntry', 'findScrolledWindow', 'findTreeView'],
    Signals: {
        'row-activated': { flags: GObject.SignalFlags.RUN_FIRST }
    }
}, class FindBox extends Gtk.Box {
    _init() {
        super._init()
        const column = this._findTreeView.get_column(0)
        column.get_area().orientation = Gtk.Orientation.VERTICAL
    }
    set epub(epub) {
        this._epub = epub
        this._findTreeView.model = this._epub.findResults
        this._epub.connect('find-results', () => {
            if (!this._epub.findResults.get_iter_first()[0])
                this._findEntry.get_style_context().add_class('error')
            this._findScrolledWindow.show()
        })
    }
    find(text) {
        this._findEntry.text = text
        this._findEntry.emit('activate')
    }
    _onFindEntryActivate() {
        const text = this._findEntry.text
        this._epub.find(text)
    }
    _onFindEntryChanged() {
        this._findEntry.get_style_context().remove_class('error')
        if (!this._findEntry.text) {
            this._epub.clearFind()
            this._findScrolledWindow.hide()
        }
    }
    _onFindRowActivated() {
        const store = this._findTreeView.model
        const selection = this._findTreeView.get_selection()
        const [, , iter] = selection.get_selected()
        const cfi = store.get_value(iter, 0)
        this._epub.goToFindResult(cfi)
        this.emit('row-activated')
    }
})

const FootnotePopover = GObject.registerClass({
    GTypeName: 'FoliateFootnotePopover',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/footnotePopover.ui',
    InternalChildren: [
        'footnoteLabel', 'controls'
    ]
}, class FootnotePopover extends Gtk.Popover {
    _init(footnote, link, epubView) {
        super._init()
        this._link = link
        this._epub = epubView
        this._footnoteLabel.label = footnote
        if (!link) this._controls.hide()
    }
    popup() {
        super.popup()
        this._footnoteLabel.select_region(-1, -1)
    }
    _goToLinkedLocation() {
        this._epub.goTo(this._link)
        this.popdown()
    }
    _activateLink(_, uri) {
        if (!isExternalURL(uri)) {
            this._epub.goTo(uri)
            this.popdown()
            return true
        }
    }
})

const SelectionPopover = GObject.registerClass({
    GTypeName: 'FoliateSelectionPopover',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/selectionPopover.ui',
    InternalChildren: ['ttsButton', 'ttsSeparator', 'ttsModelButton']
}, class SelectionPopover extends Gtk.PopoverMenu {
    _init(params) {
        super._init(params)
        this._showTts(tts.enabled)
        this._ttsHandler = tts.connect('notify::enabled', () =>
            this._showTts(tts.enabled))
    }
    _showTts(enabled) {
        this._ttsSeparator.visible = enabled
        this._ttsModelButton.visible = enabled
    }
    popup() {
        super.popup()
        this._isAlreadySpeaking = this._ttsButton.active
    }
    popdown() {
        // wrap `super.popdown()` so we can use it as a signal handler
        // without getting warnings about `popdown()` taking no arguments
        super.popdown()
    }
    _onClosed() {
        if (!this._isAlreadySpeaking) this._ttsButton.active = false
        this._ttsButton.destroy()
        tts.disconnect(this._ttsHandler)
    }
})

const AnnotationBox = GObject.registerClass({
    GTypeName: 'FoliateAnnotationBox',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/annotationBox.ui',
    InternalChildren: ['noteTextView', 'controls', 'colorButton', 'colorsBox'],
    Properties: {
        annotation: GObject.ParamSpec.object('annotation', 'annotation', 'annotation',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, EpubViewAnnotation.$gtype)
    }
}, class AnnotationBox extends Gtk.Box {
    _init(params) {
        super._init(params)
        const annotation = params.annotation

        this._noteTextView.buffer.text = annotation.note
        this._noteTextView.buffer.connect('changed', () => {
            annotation.set_property('note', this._noteTextView.buffer.text)
        })

        const buttons = highlightColors.map(color => {
            const button = new Gtk.Button({
                visible: true,
                tooltip_text: color,
                image: new Gtk.Image({
                    icon_name: 'object-select-symbolic',
                    opacity: color === annotation.color ? 1 : 0
                })
            })
            this._applyColor(button, color)
            button.connect('clicked', () => {
                if (color !== annotation.color) {
                    annotation.set_property('color', color)
                    settings.set_string('highlight', color)
                }
            })

            this._colorsBox.pack_start(button, false, true, 0)
            return button
        })

        this._applyColor(this._colorButton, annotation.color)
        const connectColor = annotation.connect('notify::color', () => {
            this._applyColor(this._colorButton, annotation.color)
            buttons.forEach(button => {
                button.image.opacity =
                    button.tooltip_text === annotation.color ? 1 : 0
            })
        })
        this.connect('destroy', () => annotation.disconnect(connectColor))
    }
    _applyColor(button, color) {
        const cssProvider = new Gtk.CssProvider()
        cssProvider.load_from_data(`
            .color-button {
                background: ${alphaColor(color, 0.5)};
            }`)
        const styleContext = button.get_style_context()
        styleContext.add_class('color-button')
        styleContext.add_provider(cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    }
    _showColors() {
        this._controls.transition_type = Gtk.StackTransitionType.SLIDE_RIGHT
        this._controls.visible_child_name = 'colors'
    }
    _showMain() {
        this._controls.transition_type = Gtk.StackTransitionType.SLIDE_LEFT
        this._controls.visible_child_name = 'main'
    }
    _chooseColor() {
        const rgba =  new Gdk.RGBA()
        rgba.parse(this.annotation.color)
        const dialog = new Gtk.ColorChooserDialog({
            rgba,
            modal: true,
            transient_for: this.get_toplevel()
        })
        if (dialog.run() === Gtk.ResponseType.OK) {
            const color = dialog.get_rgba().to_string()
            this.annotation.set_property('color', color)
        }
        dialog.destroy()
    }
})

const MainMenu = GObject.registerClass({
    GTypeName: 'FoliateMainMenu',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/mainMenu.ui',
    InternalChildren: [
        'zoomRestoreButton', 'fullscreenButton',
        'brightnessScale', 'fontButton', 'spacingButton', 'marginButton',
        'customThemesListBox', 'customThemesSep', 'themesListBox'
    ]
}, class MainMenu extends Gtk.PopoverMenu {
    _init() {
        super._init()
        this._fullscreenButton.connect('clicked', () => this.popdown())

        const flag = Gio.SettingsBindFlags.DEFAULT
        viewSettings.bind('font', this._fontButton, 'font', flag)
        viewSettings.bind('spacing', this._spacingButton, 'value', flag)
        viewSettings.bind('margin', this._marginButton, 'value', flag)
        viewSettings.bind('brightness', this._brightnessScale.adjustment, 'value', flag)

        this._updateZoom()
        const zoomHandler = settings.connect('changed::zoom-level',
            this._updateZoom.bind(this))
        this.connect('destroy', () => settings.disconnect(zoomHandler))

        const bindThemesListBoxes = themesListBox => {
            themesListBox.set_header_func((row) => {
                if (row.get_index()) row.set_header(new Gtk.Separator())
            })
            themesListBox.connect('row-activated', (_, row) =>
                applyTheme(row.theme))
        }
        bindThemesListBoxes(this._themesListBox)
        bindThemesListBoxes(this._customThemesListBox)
        this._themesListBox.bind_model(themes, theme =>
            new ThemeRow(theme))
        this._customThemesListBox.bind_model(customThemes.themes, theme =>
            new ThemeRow(theme, true))

        this._showCustomThemes()
        const customThemesHandler = customThemes.themes.connect('items-changed',
            this._showCustomThemes.bind(this))
        this.connect('destroy', () => customThemes.themes.disconnect(customThemesHandler))
    }
    _showCustomThemes() {
        const hasCustomThemes = Boolean(customThemes.themes.get_n_items())
        this._customThemesListBox.visible = hasCustomThemes
        this._customThemesSep.visible = hasCustomThemes
    }
    _updateZoom() {
        const zoomLevel = viewSettings.get_double('zoom-level')
        this._zoomRestoreButton.label = parseInt(zoomLevel * 100) + '%'
    }
    set fullscreen(isFullscreen) {
        const fullscreenImage = this._fullscreenButton.get_child()
        if (isFullscreen) {
            fullscreenImage.icon_name = 'view-restore-symbolic'
            this._fullscreenButton.tooltip_text = _('Leave fullscreen')
        } else {
            fullscreenImage.icon_name = 'view-fullscreen-symbolic'
            this._fullscreenButton.tooltip_text = _('Fullscreen')
        }
    }
})

const NavBar = GObject.registerClass({
    GTypeName: 'FoliateNavBar',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/navBar.ui',
    Children: ['locationMenu'],
    InternalChildren: [
        'locationStack', 'locationLabel', 'locationScale',
        'locationButton', 'timeInBook', 'timeInChapter',
        'sectionEntry', 'locationEntry', 'cfiEntry',
        'sectionTotal', 'locationTotal',
    ]
}, class NavBar extends Gtk.ActionBar {
    set epub(epub) {
        this._epub = epub
        this._epub.connect('locations-ready', () => {
            this._epub.sectionMarks.then(sectionMarks => {
                this._setSectionMarks(sectionMarks)
                this._loading = false
            })
        })
        this._epub.connect('book-loading', () => this._loading = true)
        this._epub.connect('relocated', () => this._update())
    }
    set _loading(loading) {
        this._locationStack.visible_child_name = loading ? 'loading' : 'loaded'
    }
    _setSectionMarks(sectionMarks) {
        this._locationScale.clear_marks()
        if (sectionMarks.length < 60) sectionMarks.forEach(x =>
            this._locationScale.add_mark(x, Gtk.PositionType.TOP, null))
    }
    _update() {
        const {
            cfi, section, sectionTotal, location, locationTotal, percentage,
            timeInBook, timeInChapter,
        } = this._epub.location

        this._locationScale.set_value(percentage)

        const progress = Math.round(percentage * 100)
        this._locationLabel.label = progress + '%'

        const makeTimeLabel = n => n < 60
            ? ngettext('%d minute', '%d minutes').format(Math.round(n))
            : ngettext('%d hour', '%d hours').format(Math.round(n / 60))

        this._timeInBook.label = makeTimeLabel(timeInBook)
        this._timeInChapter.label = makeTimeLabel(timeInChapter)
        this._sectionEntry.text = (section + 1).toString()
        this._locationEntry.text = (location + 1).toString()
        this._cfiEntry.text = cfi
        this._sectionTotal.label = _('of %d').format(sectionTotal)
        this._locationTotal.label = _('of %d').format(locationTotal + 1)
    }
    _onSectionEntryActivate() {
        const x = parseInt(this._sectionEntry.text) - 1
        this._epub.goTo(x)
    }
    _onLocationEntryActivate() {
        const x = parseInt(this._locationEntry.text) - 1
        this._epub.goToLocation(x)
    }
    _onCfiEntryActivate() {
        this._epub.goTo(this._cfiEntry.text)
    }
    _onlocationScaleChanged() {
        const value = this._locationScale.get_value()
        this._epub.goToPercentage(value)
    }
    _onSizeAllocate() {
        const narrow = this.get_allocation().width < 500
        this._locationScale.visible = !narrow
    }
    toggleLocationMenu() {
        return this._locationButton.active = !this._locationButton.active
    }
})

const MainOverlay = GObject.registerClass({
    GTypeName: 'FoliateMainOverlay',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/mainOverlay.ui',
    InternalChildren: [
        'overlayStack', 'mainBox', 'bookBox', 'contentBox',
        'navBarEventBox', 'navBar', 'navBarRevealer',
        'distractionFreeBox', 'distractionFreeBottomLabel', 'distractionFreeBottomLabel2',
        'divider', 'distractionFreeDivider'
    ]
}, class MainOverlay extends Gtk.Overlay {
    _init() {
        super._init()
        this._skeuomorphism = false

        this._navBarEventBox.connect('enter-notify-event', () =>
            this._navBarRevealer.reveal_child = true)
        this._navBarEventBox.connect('leave-notify-event', () => {
            if (!this._navBarVisible && !this._navBar.locationMenu.visible)
                this._navBarRevealer.reveal_child = false
        })
        this._navBar.locationMenu.connect('closed', () => {
            if (!this._navBarVisible) this._navBarRevealer.reveal_child = false
        })
    }
    set epub(epub) {
        this._epub = epub
        this._navBar.epub = this._epub
        this._contentBox.add(this._epub.widget)

        this._epub.connect('book-displayed', () => this._setStatus('loaded'))
        this._epub.connect('book-loading', () => {
            this._setStatus('loading')
            this._distractionFreeBottomLabel.label = '…'
            this._distractionFreeBottomLabel2.label = '…'
        })
        this._epub.connect('book-error', () => this._setStatus('error'))
        this._epub.connect('relocated', () => this._update())
        this._epub.connect('spread', (_, spread) => {
            this._spread = spread
            this._showDivider()
            this._distractionFreeBox.homogeneous = spread
            this._distractionFreeBottomLabel.xalign = spread ? 0.5 : 1
            this._distractionFreeBottomLabel2.xalign = spread ? 0.5 : 0
            this._distractionFreeBottomLabel.margin_right = spread ? 18 : 6
            this._distractionFreeBottomLabel2.margin_left = spread ? 18 : 6
        })
    }
    _update() {
        const { endCfi, location, locationTotal } = this._epub.location
        if (locationTotal) this._distractionFreeBottomLabel.label =
            (location + 1) + ' / ' + (locationTotal + 1)
        this._epub.getSectionFromCfi(endCfi).then(section =>
            this._distractionFreeBottomLabel2.label = section.label)
    }
    _setStatus(status) {
        const loaded = status === 'loaded'
        this._mainBox.opacity = loaded ? 1 : 0
        this._overlayStack.visible = !loaded
        if (!loaded) this._overlayStack.visible_child_name = status
    }
    toggleNavBar() {
        this._navBarVisible = !this._navBarVisible
        this._navBarRevealer.reveal_child = this._navBarVisible
        return this._navBarVisible
    }
    toggleLocationMenu() {
        this._navBarRevealer.reveal_child = true
        this._navBar.toggleLocationMenu()
    }
    get navbarVisible() {
        return this._navBarVisible || false
    }
    _showDivider() {
        const showDivider = this._skeuomorphism && this._spread
        this._divider.visible = showDivider
        this._distractionFreeDivider.visible = showDivider
    }
    skeuomorph(enabled) {
        this._skeuomorphism = enabled
        this._showDivider()
        if (!enabled) return this._bookBox.get_style_context()
            .remove_class('skeuomorph-page')

        const cssProvider = new Gtk.CssProvider()
        const invert = viewSettings.get_boolean('invert') ? invertRotate : (x => x)
        const brightness = viewSettings.get_double('brightness')
        const bgColor = brightenColor(invert(viewSettings.get_string('bg-color')), brightness)
        const shadowColor = 'rgba(0, 0, 0, 0.2)'
        cssProvider.load_from_data(`
            .skeuomorph-page {
                margin: 12px 24px;
                box-shadow:
                    -26px 0 0 -14px ${shadowColor},
                    -26px 0 0 -15px ${bgColor},

                    26px 0 0 -14px ${shadowColor},
                    26px 0 0 -15px ${bgColor},

                    -18px 0 0 -9px ${shadowColor},
                    -18px 0 0 -10px ${bgColor},

                    18px 0 0 -9px ${shadowColor},
                    18px 0 0 -10px ${bgColor},

                    -10px 0 0 -4px ${shadowColor},
                    -10px 0 0 -5px ${bgColor},

                    10px 0 0 -4px ${shadowColor},
                    10px 0 0 -5px ${bgColor},

                    0 0 15px 5px ${shadowColor},
                    0 0 0 1px ${shadowColor};
            }
            .spread-divider {
                background: rgba(0, 0, 0, 0.3);
                box-shadow: 0 0 10px 5px rgba(0, 0, 0, 0.15);
            }`)
        const styleContext = this._bookBox.get_style_context()
        styleContext.add_class('skeuomorph-page')
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    }
})

const copyPixbuf = pixbuf => Gtk.Clipboard
    .get_default(Gdk.Display.get_default())
    .set_image(pixbuf)

class ImgViewer {
    constructor(parent, pixbuf, alt) {
        const width = pixbuf.get_width()
        const height = pixbuf.get_height()
        const [windowWidth, windowHeight] = parent.get_size()
        const window = new Gtk.Window({
            default_width: Math.min(width * 2, windowWidth),
            default_height: Math.min(height * 2 + 70, windowHeight),
            transient_for: parent
        })
        const headerBar = new Gtk.HeaderBar()
        headerBar.show_close_button = true
        headerBar.has_subtitle = false
        window.set_titlebar(headerBar)
        window.title = alt

        const button = new Gtk.Button({ label: _('Copy') })
        button.connect('clicked', () => copyPixbuf(pixbuf))
        headerBar.pack_start(button)

        const slider = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 0.1, upper: 4, step_increment: 0.1
            }),
            digits: 2,
            hexpand: true,
            draw_value: false
        })
        slider.set_value(1)
        slider.connect('format-value',
            (_, x) => `${Math.round(x * 100)}%`)
        slider.add_mark(1, Gtk.PositionType.BOTTOM, '100%')
        slider.add_mark(2, Gtk.PositionType.BOTTOM, '200%')
        slider.add_mark(4, Gtk.PositionType.BOTTOM, '400%')
        slider.connect('value-changed', () => {
            const zoom = slider.get_value()
            image.set_from_pixbuf(pixbuf.scale_simple(
                width * zoom,
                height * zoom,
                GdkPixbuf.InterpType.BILINEAR))
        })
        const bar = new Gtk.ActionBar()
        bar.pack_start(slider)

        const scroll = new Gtk.ScrolledWindow()
        const image = Gtk.Image.new_from_pixbuf(pixbuf)
        scroll.add(image)
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL
        })
        container.pack_start(scroll, true, true, 0)
        container.pack_end(bar, false, true, 0)
        window.add(container)

        window.show_all()
    }
}

const makeActions = self => ({
    'selection-menu': () => self._showSelectionPopover(),
    'selection-copy': () => {
        Gtk.Clipboard.get_default(Gdk.Display.get_default())
            .set_text(self._epub.selection.text, -1)
    },
    'selection-highlight': () => {
        const { cfi, text } = self._epub.selection
        const color = settings.get_string('highlight')
        self._epub.addAnnotation({ cfi, color, text, note: '' })
        self._epub.emit('highlight-menu')
    },
    'selection-unhighlight': () => {
        const annotation = self._epub.annotation
        self._epub.removeAnnotation(annotation)
        if (self._highlightMenu.visible) self._highlightMenu.popdown()
    },
    'selection-dictionary': () => {
        const { language, text } = self._epub.selection
        const popover = new Gtk.Popover()
        const dictionaryBox = new DictionaryBox({ border_width: 10 },
            settings.get_string('dictionary'))
        dictionaryBox.dictCombo.connect('changed', () =>
            settings.set_string('dictionary', dictionaryBox.dictCombo.active_id))
        popover.add(dictionaryBox)
        dictionaryBox.lookup(text, language)
        self._showPopover(popover)
    },
    'selection-wikipedia': () => {
        const { language, text } = self._epub.selection
        const popover = new Gtk.Popover()
        const wikipediaBox = new WikipediaBox({ border_width: 10 })
        popover.add(wikipediaBox)
        wikipediaBox.lookup(text, language)
        self._showPopover(popover)
    },
    'selection-translate': () => {
        const { text } = self._epub.selection
        const popover = new Gtk.Popover()
        const translationBox = new TranslationBox({ border_width: 10 },
            settings.get_string('translate-target-language'))
        translationBox.langCombo.connect('changed', () =>
            settings.set_string('translate-target-language',
                translationBox.langCombo.active_id))
        popover.add(translationBox)
        translationBox.lookup(text)
        self._showPopover(popover)
    },
    'selection-find': () => {
        const { text } = self._epub.selection
        self._findBox.find(text)
        self._findMenuButton.active = true
    },
    'selection-speech-start': () => {
        tts.epub = self._epub
        tts.start(self._epub.selection.cfi)
    },
    'speak': () => {
        if (!tts.enabled) return
        tts.epub = self._epub
        if (tts.speaking) tts.stop()
        else tts.start()
    },

    'side-menu': () => self.toggleSideMenu(),
    'find-menu': () => self.toggleFindMenu(),
    'main-menu': () => self.toggleMainMenu(),
    'location-menu': () => self.toggleLocationMenu(),

    'fullscreen': () =>
        self._isFullscreen ? self.unfullscreen() : self.fullscreen(),
    'unfullscreen': () => self.unfullscreen(),

    'properties': () => {
        const window = new PropertiesWindow({
            modal: true,
            transient_for: self,
            use_header_bar: true
        }, self._epub.metadata, self._epub.cover)
        window.show()
    },
    'open-copy': () => {
        const window = new self.constructor({
            application: self.application,
            file: self.file
        })
        window.present()
    },
    'reload': () => {
        self.open(self.file)
    },
    'export-annotations': () => {
        const data = self._epub.data
        if (!data.annotations || !data.annotations.length) {
            const msg = new Gtk.MessageDialog({
                text: _('No annotations'),
                secondary_text: _("You don't have any annotations for this book.")
                    + '\n' + _('Highlight some text to add annotations.'),
                message_type: Gtk.MessageType.INFO,
                buttons: [Gtk.ButtonsType.OK],
                modal: true,
                transient_for: self
            })
            msg.run()
            msg.destroy()
            return
        }
        exportAnnotations(self, data, self._epub.metadata, cfi =>
            self._epub.getSectionFromCfi(cfi).then(x => x.label))
            .catch(e => logError(e))
    },
    'close': () => self.close(),
})

var FoliateWindow = GObject.registerClass({
    GTypeName: 'FoliateWindow',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/window.ui',
    Properties: {
        file: GObject.ParamSpec.object('file', 'file', 'file',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, Gio.File.$gtype)
    },
    InternalChildren: [
        'mainOverlay',
        'sideMenu', 'contentsStack', 'findMenu', 'findBox', 'mainMenu',
        'headerBarEventBox', 'headerBarRevealer',
        'distractionFreeTitle',
        'headerBar', 'sideMenuButton', 'findMenuButton', 'mainMenuButton',
        'fullscreenEventbox', 'fullscreenRevealer',
        'fullscreenHeaderbar', 'fullscreenSideMenuButton',
        'fullscreenFindMenuButton', 'fullscreenMainMenuButton'
    ]
}, class FoliateWindow extends Gtk.ApplicationWindow {
    _init(params) {
        super._init(params)

        this._buildUI()

        const actions = makeActions(this)
        Object.keys(actions).forEach(name => {
            const action = new Gio.SimpleAction({ name })
            action.connect('activate', actions[name])
            this.add_action(action)
        })

        this._themeUI()
        const themeHandlers = [
            viewSettings.connect('changed::bg-color', () => this._themeUI()),
            viewSettings.connect('changed::fg-color', () => this._themeUI()),
            viewSettings.connect('changed::invert', () => this._themeUI()),
            viewSettings.connect('changed::brightness', () => this._themeUI()),
            viewSettings.connect('changed::skeuomorphism', () => this._themeUI())
        ]

        const updateTTS = () => tts.command = settings.get_string('tts-command')
        updateTTS()
        const ttsHandler = settings.connect('changed::tts-command', updateTTS)

        this.connect('destroy', () => {
            themeHandlers.forEach(x => settings.disconnect(x))
            settings.disconnect(ttsHandler)
        })

        this._loading = true
        this._mainOverlay.status = 'empty'
        this.title = _('Foliate')

        // restore window state
        this.default_width = windowState.get_int('width')
        this.default_height = windowState.get_int('height')
        if (windowState.get_boolean('maximized')) this.maximize()
        if (windowState.get_boolean('fullscreen')) this.fullscreen()

        const lastFile = windowState.get_string('last-file')
        if (!this.file && settings.get_boolean('restore-last-file') && lastFile)
            this.file  = Gio.File.new_for_path(lastFile)

        this._epub = new EpubView()
        this._connectEpub()
        this.connect('destroy', () => this._epub.close())
        if (this.file) this.open(this.file)
    }
    open(file) {
        this.file = file
        this._epub.open(file)
    }
    get _alwaysRevealHeaderBar() {
        return viewSettings.get_boolean('skeuomorphism')
    }
    set _revealHeaderBar(reveal) {
        if (this._alwaysRevealHeaderBar || reveal)
            this._headerBarRevealer.reveal_child = true
        else if (!this._loading
        && !this._sideMenu.visible
        && !this._findMenu.visible
        && !this._mainMenu.visible
        && !this._mainOverlay.navbarVisible)
            this._headerBarRevealer.reveal_child = false
    }
    _buildUI() {
        this.set_help_overlay(Gtk.Builder.new_from_resource(
            '/com/github/johnfactotum/Foliate/ui/shortcutsWindow.ui')
            .get_object('shortcutsWindow'))
        this.application.set_accels_for_action('win.show-help-overlay',
            ['<ctrl>question'])

        this._headerBarEventBox.connect('enter-notify-event', () =>
            this._revealHeaderBar = true)
        this._headerBarEventBox.connect('leave-notify-event', () =>
            this._revealHeaderBar = false)

        const showHeaderBar = widget => {
            if (widget.visible) {
                this._fullscreenRevealer.reveal_child = true
                this._headerBarRevealer.reveal_child = true
            }
        }
        const hideHeaderBar = () => {
            if (!this._loading && !this._mainOverlay.navbarVisible) {
                this._fullscreenRevealer.reveal_child = false
                this._headerBarRevealer.reveal_child =
                    this._alwaysRevealHeaderBar || false
            }
        }
        this._fullscreenEventbox.connect('enter-notify-event', () =>
            this._fullscreenRevealer.reveal_child = true)
        this._fullscreenEventbox.connect('leave-notify-event', () => {
            if (!this._sideMenu.visible
            && !this._findMenu.visible
            && !this._mainMenu.visible
            && !this._mainOverlay.navbarVisible)
                this._fullscreenRevealer.reveal_child = false
        })
        this._sideMenu.connect('notify::visible', showHeaderBar)
        this._findMenu.connect('notify::visible', showHeaderBar)
        this._mainMenu.connect('notify::visible', showHeaderBar)
        this._sideMenu.connect('closed', hideHeaderBar)
        this._findMenu.connect('closed', hideHeaderBar)
        this._mainMenu.connect('closed', hideHeaderBar)
        this.connect('notify::title', () => {
            this._distractionFreeTitle.label = this.title
            this._headerBar.title = this.title
            this._fullscreenHeaderbar.title = this.title
        })

        this._contentsStack.connect('row-activated', () => this._sideMenu.popdown())
        this._findBox.connect('row-activated', () => this._findMenu.popdown())

        const gtkTheme = Gtk.Settings.get_default().gtk_theme_name
        if (gtkTheme === 'elementary') {
            this._headerBar.get_style_context().add_class('default-decoration')
            this._sideMenuButton.get_style_context().add_class('flat')
            this._findMenuButton.get_style_context().add_class('flat')
            this._mainMenuButton.get_style_context().add_class('flat')
        }
    }
    _onWindowStateEvent(widget, event) {
        const state = event.get_window().get_state()
        this._isFullscreen = Boolean(state & Gdk.WindowState.FULLSCREEN)
        this._mainMenu.fullscreen = this._isFullscreen

        this._fullscreenEventbox.visible = this._isFullscreen
        this._fullscreenRevealer.reveal_child = this._mainOverlay.navbarVisible
        if (this._isFullscreen) {
            this._sideMenu.relative_to = this._fullscreenSideMenuButton
            this._findMenu.relative_to = this._fullscreenFindMenuButton
            this._mainMenu.relative_to = this._fullscreenMainMenuButton
        } else {
            this._sideMenu.relative_to = this._sideMenuButton
            this._findMenu.relative_to = this._findMenuButton
            this._mainMenu.relative_to = this._mainMenuButton
        }
    }
    _onSizeAllocate() {
        const [width, height] = this.get_size()
        this._width = width
        this._height = height
    }
    _onDestroy() {
        windowState.set_int('width', this._width)
        windowState.set_int('height', this._height)
        windowState.set_boolean('maximized', this.is_maximized)
        windowState.set_boolean('fullscreen', this._isFullscreen)
        if (this.file)
            windowState.set_string('last-file', this.file.get_path())

        if (tts.epub === this._epub) tts.stop()
    }
    get _loading() {
        return this.__loading
    }
    set _loading(state) {
        this.__loading = state
        this._sideMenuButton.sensitive = !state
        this._findMenuButton.sensitive = !state
        this._fullscreenSideMenuButton.sensitive = !state
        this._fullscreenFindMenuButton.sensitive = !state
        this.lookup_action('side-menu').enabled = !state
        this.lookup_action('find-menu').enabled = !state
        this.lookup_action('location-menu').enabled = !state
        this.lookup_action('open-copy').enabled = !state
        this.lookup_action('reload').enabled = !state
        this._revealHeaderBar = state || this._mainOverlay.navbarVisible
        if (state) {
            this.lookup_action('properties').enabled = false
            this.lookup_action('export-annotations').enabled = false
            this.title = _('Loading…')
        }
    }
    _connectEpub() {
        this.insert_action_group('view', this._epub.actionGroup)

        this._mainOverlay.epub = this._epub
        this._contentsStack.epub = this._epub
        this._findBox.epub = this._epub

        this._epub.connect('click', () => {
            if (this._highlightMenu && this._highlightMenu.visible) return
            const visible = this._mainOverlay.toggleNavBar()
            if (this._isFullscreen)
                this._fullscreenRevealer.reveal_child = visible
            else this._revealHeaderBar = visible
        })
        this._epub.connect('book-displayed', () => this._loading = false)
        this._epub.connect('book-loading', () => {
            this._loading = true
            if (tts.epub === this._epub) tts.stop()
        })
        this._epub.connect('book-error', () => this.title = _('Error'))
        this._epub.connect('metadata', () =>
            this.title = this._epub.metadata.title)
        this._epub.connect('cover', () =>
            this.lookup_action('properties').enabled = true)
        this._epub.connect('data-ready', () =>
            this.lookup_action('export-annotations').enabled = true)
        this._epub.connect('selection', () => {
            const { text } = this._epub.selection
            if (!text) return
            const isSingle = text.split(/\s/).length === 1
            const action = settings.get_string(isSingle
                ? 'selection-action-single' : 'selection-action-multiple')
            switch (action) {
                case 'highlight':
                    this.lookup_action('selection-highlight').activate(null)
                    break
                case 'copy':
                    this.lookup_action('selection-copy').activate(null)
                    break
                case 'dictionary':
                    this.lookup_action('selection-dictionary').activate(null)
                    break
                case 'wikipedia':
                    this.lookup_action('selection-wikipedia').activate(null)
                    break
                case 'translate':
                    this.lookup_action('selection-translate').activate(null)
                    break
                case 'find':
                    this.lookup_action('selection-find').activate(null)
                    break
                case 'speak':
                    this.lookup_action('speak').activate(null)
                    break
                case 'none':
                    break
                default:
                    this.lookup_action('selection-menu').activate(null)
            }
        })
        this._epub.connect('highlight-menu', () => {
            const annotation = this._epub.annotation
            this._highlightMenu = new Gtk.Popover()
            this._highlightMenu.add(new AnnotationBox({ annotation, visible: true }))
            this._showPopover(this._highlightMenu, false)
        })
        this._epub.connect('footnote', () => {
            const { footnote, link, position } = this._epub.footnote
            const popover = new FootnotePopover(footnote, link, this._epub)
            popover.relative_to = this._epub.widget
            setPopoverPosition(popover, position, this, 200)
            popover.popup()
        })
        this._epub.connect('img', (_, pixbuf, alt) => {
            new ImgViewer(this, pixbuf, alt)
        })
    }
    _showSelectionPopover() {
        this._showPopover(new SelectionPopover())
    }
    _showPopover(popover, select = true) {
        popover.relative_to = this._epub.widget
        setPopoverPosition(popover, this._epub.selection.position, this, 200)
        popover.popup()
        if (select) {
            this._epub.selectByCfi(this._epub.selection.cfi)
            popover.connect('closed', () => this._clearSelection())
        } else this._clearSelection()
    }
    _clearSelection() {
        this._epub.clearSelection()
    }
    _themeUI() {
        this._mainOverlay.skeuomorph(viewSettings.get_boolean('skeuomorphism'))
        this._revealHeaderBar = false

        const invert = viewSettings.get_boolean('invert') ? invertRotate : (x => x)
        const brightness = viewSettings.get_double('brightness')
        const bgColor = brightenColor(invert(viewSettings.get_string('bg-color')), brightness)
        const fgColor = brightenColor(invert(viewSettings.get_string('fg-color')), brightness)
        const cssProvider = new Gtk.CssProvider()
        cssProvider.load_from_data(`
            .distraction-free-container {
                background: ${bgColor};
                border: 0;
                box-shadow: none;
            }
            .distraction-free-label {
                color: ${fgColor};
            }`)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    }
    toggleSideMenu() {
        this._sideMenu.relative_to.active = !this._sideMenu.relative_to.active
    }
    toggleFindMenu() {
        this._findMenu.relative_to.active = !this._findMenu.relative_to.active
    }
    toggleMainMenu() {
        this._mainMenu.relative_to.active = !this._mainMenu.relative_to.active
    }
    toggleLocationMenu() {
        this._mainOverlay.toggleLocationMenu()
    }
    get epub() {
        return this._epub
    }
})
