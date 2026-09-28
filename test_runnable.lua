-- Runnable correctness test (plain Lua subset, no Roblox globals, no Luau-only syntax)
local function calculateDamage(baseDamage, multiplier)
	local result = baseDamage * multiplier
	if result > 100 then
		result = 100
	end
	return result
end

local Weapon = {}
Weapon.__index = Weapon

function Weapon.new(name, damage)
	local self = setmetatable({}, Weapon)
	self.name = name
	self.damage = damage
	self.hits = 0
	return self
end

function Weapon:Fire(target)
	self.hits = self.hits + 1
	local dmg = calculateDamage(self.damage, 1.5)
	print(self.name .. " hit " .. target .. " for " .. dmg)
	return dmg
end

local totalDamage = 0
for i = 1, 5 do
	totalDamage = totalDamage + i * 2
end
print("total", totalDamage)

local names = {"sword", "bow", "staff"}
for index, weaponName in ipairs(names) do
	print(index, weaponName)
end

local config = {
	maxHealth = 100,
	regen = 1.5,
	tags = {"melee", "fast"},
}
print(config.maxHealth, config.regen, config.tags[1], config.tags[2])

local w = Weapon.new("Sword", 20)
w:Fire("Goblin")
w:Fire("Dragon")
print("hits", w.hits)

-- while / repeat / nested function / closures / varargs
local function sum(...)
	local total = 0
	local args = {...}
	for i = 1, #args do total = total + args[i] end
	return total
end
print("sum", sum(1,2,3,4,5))

local counter = 0
while counter < 3 do
	counter = counter + 1
end
print("counter", counter)

local n = 0
repeat
	n = n + 1
until n >= 4
print("n", n)

local function makeCounter()
	local c = 0
	return function()
		c = c + 1
		return c
	end
end
local inc = makeCounter()
print(inc(), inc(), inc())

-- string ops, escapes, long strings, unicode
local s = "line1\nline2\ttabbed"
print(#s)
local long = [[
multi
line
]]
print(#long)
print("emoji: \xc3\xa9 caf\xc3\xa9") -- é (utf8 bytes literal via \x escapes)
print("héllo wörld")

-- goto / label / break / continue-like patterns
do
	local total2 = 0
	for i = 1, 10 do
		if i % 2 == 0 then
			goto continue_label
		end
		total2 = total2 + i
		::continue_label::
	end
	print("total2", total2)
end

for i = 1, 10 do
	if i > 5 then break end
	io.write(i, " ")
end
print()

return Weapon
