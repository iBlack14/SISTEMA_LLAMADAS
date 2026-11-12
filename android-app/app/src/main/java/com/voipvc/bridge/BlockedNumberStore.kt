package com.voipvc.bridge

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class BlockedNumber(val name: String, val number: String)

object BlockedNumberStore {
    private const val PREFS = "blocked_numbers"
    private const val ENTRIES_KEY = "entries"
    private const val LEGACY_NUMBERS_KEY = "numbers"

    fun read(context: Context): List<BlockedNumber> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val saved = prefs.getString(ENTRIES_KEY, null)
        if (saved != null) {
            return runCatching { fromJsonArray(JSONArray(saved)) }.getOrDefault(emptyList())
        }

        val legacy = prefs.getStringSet(LEGACY_NUMBERS_KEY, emptySet()).orEmpty()
            .map { BlockedNumber(it, it) }
        if (legacy.isNotEmpty()) replace(context, legacy)
        return legacy
    }

    fun replace(context: Context, entries: List<BlockedNumber>) {
        val unique = linkedMapOf<String, BlockedNumber>()
        entries.forEach { entry ->
            val number = entry.number.trim()
            val key = numberKey(number)
            if (key.isNotBlank()) {
                unique[key] = BlockedNumber(entry.name.trim().ifBlank { number }, number)
            }
        }
        val normalized = unique.values.toList()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(ENTRIES_KEY, toJsonArray(normalized).toString())
            .putStringSet(LEGACY_NUMBERS_KEY, normalized.map { it.number }.toSet())
            .apply()
    }

    fun contains(context: Context, number: String): Boolean {
        val key = numberKey(number)
        return key.isNotBlank() && read(context).any { numberKey(it.number) == key }
    }

    fun setBlocked(context: Context, name: String, number: String, blocked: Boolean) {
        val key = numberKey(number)
        if (key.isBlank()) return
        val entries = read(context).filterNot { numberKey(it.number) == key }.toMutableList()
        if (blocked) entries.add(BlockedNumber(name.trim().ifBlank { number.trim() }, number.trim()))
        replace(context, entries)
    }

    fun fromJsonArray(array: JSONArray): List<BlockedNumber> =
        (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val number = item.optString("phone", item.optString("number")).trim()
            if (numberKey(number).isBlank()) return@mapNotNull null
            BlockedNumber(item.optString("name").trim().ifBlank { number }, number)
        }

    fun toJsonArray(entries: List<BlockedNumber> = emptyList()): JSONArray =
        JSONArray().apply {
            entries.forEach { entry ->
                put(JSONObject().put("name", entry.name).put("phone", entry.number))
            }
        }

    private fun numberKey(number: String): String {
        val digits = number.filter(Char::isDigit)
        return if (digits.length == 11 && digits.startsWith("51")) digits.drop(2) else digits
    }
}
