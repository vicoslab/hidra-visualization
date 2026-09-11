
var localization = function(){
    let values = {
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
