-- Luau-only syntax exercised here (parsed/obfuscated but not run through texlua,
-- since texlua is a Lua 5.x engine, not Luau)
local function process(items: {number}, threshold: number): number
	local total: number = 0
	for i, v in ipairs(items) do
		if v < threshold then
			continue
		end
		total += v
	end
	return total
end

local x: number, y: string = 5, "hi"
x -= 1
y ..= "!"

local label = if x > 0 then "positive" elseif x < 0 then "negative" else "zero"

type Point = { x: number, y: number }
export type Callback<T> = (T) -> boolean

local function identity<T>(v: T): T
	return v
end

local greeting = `Hello, {y}! Total is {x}`

local t = {1, 2, 3}
local ok, err = pcall(function()
	return process(t, 2)
end)
print(ok, err, label, greeting)
