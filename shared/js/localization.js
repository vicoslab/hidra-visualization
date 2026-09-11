
var localization = function(){
    let values = {
        "archiveHelp": {"en": "The slider shows the latest 30 runs. Select an archive date for older data. Source file dates may differ from forecast issue times.", "sl": "Drsnik prikazuje zadnjih 30 napovedi. Za starejše podatke izberite datum v arhivu. Datum izvorne datoteke se lahko razlikuje od časa izdaje napovedi."},
        "archiveEmpty": {"en": "No archived run for this date. Choose another date.", "sl": "Za ta datum ni arhivirane napovedi. Izberite drug datum."},
        "archiveLoading": {"en": "Loading historical forecast and measurements…", "sl": "Nalaganje zgodovinske napovedi in meritev…"},
        "archiveSelected": {"en": "Archive ID — forecast issue time (CET): ", "sl": "ID v arhivu — čas izdaje napovedi (CET): "},
        "archiveFailed": {"en": "Historical data could not be loaded. Please retry.", "sl": "Zgodovinskih podatkov ni mogoče naložiti. Poskusite znova."},

        "stale": {
            'sl': "Podatki so lahko zastareli. Preverite datum napovedi in uradna opozorila ARSO; te strani ne uporabljajte kot edini vir za varnostne odločitve.",
            'en': "Data may be out of date. Check the forecast date and official ARSO warnings; do not use this page as your only source for safety decisions."
        },
        "HIDRA3 napoved": {
            'sl': "HIDRA3 napoved (±2σ)",
            'en': "HIDRA3 forecast (±2σ)"
        },
        "Izmerjena višina": {
            'sl': "Izmerjena višina",
            'en': "Sea-level measurement"
        },
        "Višina [cm]": {
            'sl': "Višina morske gladine [cm]",
            'en': "Sea-level [cm]"
        },
        "Datum napovedi: ": {
            'sl': "Datum napovedi: ",
            'en': "Forecast date: "
        }
    };

    return {
        localize: function(key, lang){
            return values[key][lang] || key;
        }
    }
}();
