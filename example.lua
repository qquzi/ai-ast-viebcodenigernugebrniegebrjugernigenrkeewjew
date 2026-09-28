-- A small sample module to exercise the obfuscator
local Players = game:GetService("Players")

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

local names = {"sword", "bow", "staff"}
for index, weaponName in ipairs(names) do
	print(index, weaponName)
end

local config = {
	maxHealth = 100,
	regen = 1.5,
	tags = {"melee", "fast"},
}

return Weapon
